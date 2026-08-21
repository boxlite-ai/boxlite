package main

// forked_udp.go — UDP forwarding gated by the allow_net allowlist + egress
// rate limiting.
//
// The policy check runs at the protocol-handler level, before the forwarder
// creates an endpoint, and allowed datagrams are handed to that forwarder —
// same shape as Tailscale's wrapUDPProtocolHandler. The forwarder itself is a
// fork (UDPWithRateLimit in forked_udp_forwarder.go) that shapes ingress.
//
// Traffic that never reaches here: the gateway DNS resolver (bound to
// GatewayIP:53, services.go:62) and DHCP (bound to :67, dhcp.go:93) are
// registered endpoints, and gVisor's demuxer matches those before falling
// back to this default handler (gvisor stack/nic.go:863-871). Internal
// services therefore need no allowlist exemption.

import (
	"net"
	"sync"
	"time"

	logrus "github.com/sirupsen/logrus"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
)

// UDPWithFilter returns a UDP protocol handler that drops datagrams whose
// destination is outside the allowlist and forwards the rest through
// upstream's forwarder. A nil filter forwards everything.
func UDPWithFilter(s *stack.Stack, nat map[tcpip.Address]tcpip.Address,
	natLock *sync.Mutex, filter *AllowNetFilter, rl *netRateLimiter) func(stack.TransportEndpointID, *stack.PacketBuffer) bool {

	upstream := UDPWithRateLimit(s, nat, natLock, rl)

	var handler func(stack.TransportEndpointID, *stack.PacketBuffer) bool
	if filter == nil {
		handler = upstream.HandlePacket
	} else {
		blocked := newBlockedDestinationLog()
		handler = func(id stack.TransportEndpointID, pkt *stack.PacketBuffer) bool {
			// Policy sees the pre-NAT destination, matching the TCP path
			// (resolveTCPDestination, forked_tcp.go:83). Upstream applies NAT
			// itself once the datagram is allowed through.
			if !udpDestinationAllowed(id.LocalAddress, filter) {
				blocked.note(id.LocalAddress, id.LocalPort)
				// Consumed: a silent drop. Returning false would make gVisor
				// emit ICMP port-unreachable, handing the guest a probe oracle.
				return true
			}
			return upstream.HandlePacket(id, pkt)
		}
	}

	// UDP egress rate limiting: police the guest → internet datagrams before
	// they reach the forwarder. UDP has no flow control, so over-limit
	// datagrams are dropped rather than buffered — this also keeps the gVisor
	// packet-processing path from blocking (which would stall TCP on the same
	// NIC). Ingress (host → guest) is shaped in the forked UDPWithRateLimit
	// (forked_udp_forwarder.go) by throttling the dialed conn's reads.
	if rl != nil && rl.upload != nil {
		upload := rl.upload
		return func(id stack.TransportEndpointID, pkt *stack.PacketBuffer) bool {
			if !upload.AllowN(time.Now(), pkt.Size()) {
				return true // over-limit: drop the datagram
			}
			return handler(id, pkt)
		}
	}

	return handler
}

// udpDestinationAllowed applies the same link-local and broadcast guards as
// upstream (forwarder/udp.go:21) and then the allowlist.
//
// Hostname rules cannot be evaluated here — UDP carries no SNI or Host header
// to peek at — so an allowlist holding only hostnames denies all UDP egress.
// A guest must not be able to sidestep a hostname rule by addressing the
// resolved IP directly.
func udpDestinationAllowed(dest tcpip.Address, filter *AllowNetFilter) bool {
	// Link-local stays denied even when ec2MetadataAccess is on: IMDS speaks
	// HTTP over TCP, so opening UDP to 169.254.0.0/16 would only add egress.
	if linkLocalSubnet.Contains(dest) || dest == header.IPv4Broadcast {
		return false
	}
	addr4 := dest.As4()
	return filter.MatchesIP(net.IP(addr4[:]))
}

// maxLoggedDestinations bounds the distinct destinations that earn their own
// log line. Chosen to cover a realistic misconfiguration (a handful of
// endpoints) without letting a port scan size the map.
const maxLoggedDestinations = 256

type udpDestination struct {
	addr tcpip.Address
	port uint16
}

// blockedDestinationLog keeps drop logging bounded. UDP is connectionless and
// a guest can emit thousands of denied datagrams per second, so logging every
// drop the way the TCP path logs every blocked connection would let the guest
// flood the log. Output is capped at one line per distinct destination plus
// one per order-of-magnitude of total drops.
type blockedDestinationLog struct {
	mu            sync.Mutex
	seen          map[udpDestination]bool
	dropped       uint64
	nextMilestone uint64
}

func newBlockedDestinationLog() *blockedDestinationLog {
	return &blockedDestinationLog{
		seen:          make(map[udpDestination]bool),
		nextMilestone: 1,
	}
}

func (b *blockedDestinationLog) note(addr tcpip.Address, port uint16) {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.dropped++

	key := udpDestination{addr: addr, port: port}
	newDestination := !b.seen[key] && len(b.seen) < maxLoggedDestinations
	if newDestination {
		b.seen[key] = true
	}

	milestone := b.dropped >= b.nextMilestone
	if milestone {
		b.nextMilestone *= 10
	}

	if !newDestination && !milestone {
		return
	}

	logrus.WithFields(logrus.Fields{
		"dst_ip":        addr,
		"dst_port":      port,
		"dropped_total": b.dropped,
	}).Info("allowNet UDP: blocked (no matching rule)")
}
