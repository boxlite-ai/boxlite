package main

import (
	"context"
	"math"
	"net"
	"net/netip"
	"sync"

	"github.com/containers/gvisor-tap-vsock/pkg/services/forwarder"
	logrus "github.com/sirupsen/logrus"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
	"gvisor.dev/gvisor/pkg/tcpip/transport/udp"
)

// outboundUDPHandler runs after the global mode gate and gVisor endpoint demux.
// Registered services and established flows are delivered by the stack.
func outboundUDPHandler(s *stack.Stack, nat map[tcpip.Address]tcpip.Address,
	natLock *sync.Mutex, snapshot snapshotSource, flows *udpFlowPool) func(stack.TransportEndpointID, *stack.PacketBuffer) bool {
	upstream := forwarder.UDP(s, nat, natLock)
	blocked := newBlockedDestinationLog()
	var registration sync.Mutex
	return func(id stack.TransportEndpointID, pkt *stack.PacketBuffer) bool {
		registration.Lock()
		defer registration.Unlock()
		current := snapshot()
		guard := current.dialer.guard
		if current.policy.Mode == "disabled" || !guard.active() {
			return true
		}
		// Two packets may miss demux before one registers the endpoint.
		if endpoint := s.FindTransportEndpoint(pkt.NetworkProtocolNumber, udp.ProtocolNumber, id, pkt.NICID); endpoint != nil {
			endpoint.HandlePacket(id, pkt)
			return true
		}
		if current.extended != nil || current.dialer.guard.requiresCheckedUDP() {
			target, reason := udpAdmission(id, nat, natLock, current)
			if reason != outboundAllowed {
				blocked.note(id.LocalAddress, id.LocalPort, reason)
			} else if !flows.admit(s, id, pkt, target, current.dialer.dialUDP) && flows.ctx.Err() == nil {
				blocked.note(id.LocalAddress, id.LocalPort, "flow-capacity")
			}
			return true
		}
		filter := current.filter
		if filter != nil && !udpDestinationAllowed(id.LocalAddress, filter) {
			blocked.note(id.LocalAddress, id.LocalPort, outboundAllowMiss)
			return true
		}
		return upstream.HandlePacket(id, pkt)
	}
}

func (d *egressDialer) dialUDP(ctx context.Context, network, address string) (net.Conn, error) {
	if !d.guard.active() {
		return nil, net.ErrClosed
	}
	conn, err := d.dial(ctx, network, address)
	if err != nil {
		return conn, err
	}
	return d.guard.track(conn)
}

func udpAdmission(id stack.TransportEndpointID, nat map[tcpip.Address]tcpip.Address,
	natLock *sync.Mutex, snapshot *outboundSnapshot) (egressTarget, outboundReason) {
	original := id.LocalAddress
	translated := original
	natLock.Lock()
	if address, ok := nat[original]; ok {
		translated = address
	}
	natLock.Unlock()
	if original.Len() != net.IPv4len || translated.Len() != net.IPv4len {
		return egressTarget{}, outboundInvalidTarget
	}
	target := egressTarget{
		PolicyIP: netip.AddrFrom4(original.As4()), ConnectionIP: netip.AddrFrom4(translated.As4()),
		Port: id.LocalPort, Protocol: "udp", PolicyRevision: snapshot.revision,
	}
	if snapshot.dialer.guard.denies(target.PolicyIP) || snapshot.dialer.guard.denies(target.ConnectionIP) {
		return egressTarget{}, outboundPlatformDeny
	}
	if snapshot.extended == nil {
		if !udpDestinationAllowed(original, snapshot.filter) {
			return egressTarget{}, outboundAllowMiss
		}
		return target, outboundAllowed
	}
	decision := snapshot.extended.evaluate(target, snapshot.egressAddressFacts(target.PolicyIP, false), outboundNameFacts{})
	if decision.reason != outboundAllowed {
		return egressTarget{}, decision.reason
	}
	if snapshot.egressAddressFacts(target.ConnectionIP, false).platformDenied {
		return egressTarget{}, outboundPlatformDeny
	}
	return target, outboundAllowed
}

// udpDestinationAllowed applies the same link-local and broadcast guards as
// upstream (forwarder/udp.go:21) and then the allowlist.
//
// Hostname rules cannot be evaluated here — UDP carries no SNI or Host header
// to peek at — so an allowlist holding only hostnames denies all UDP egress.
// A guest must not be able to sidestep a hostname rule by addressing an
// allowed name's current IP directly.
func udpDestinationAllowed(dest tcpip.Address, filter *AllowNetFilter) bool {
	// Link-local stays denied even when ec2MetadataAccess is on: IMDS speaks
	// HTTP over TCP, so opening UDP to 169.254.0.0/16 would only add egress.
	if linkLocalSubnet.Contains(dest) || dest == header.IPv4Broadcast {
		return false
	}
	if filter == nil {
		return true
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

func (b *blockedDestinationLog) note(addr tcpip.Address, port uint16, reason outboundReason) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if b.dropped < math.MaxUint64 {
		b.dropped++
	}

	key := udpDestination{addr: addr, port: port}
	newDestination := !b.seen[key] && len(b.seen) < maxLoggedDestinations
	if newDestination {
		b.seen[key] = true
	}

	milestone := b.nextMilestone != 0 && b.dropped >= b.nextMilestone
	if milestone {
		if b.nextMilestone <= math.MaxUint64/10 {
			b.nextMilestone *= 10
		} else {
			b.nextMilestone = 0
		}
	}

	if !newDestination && !milestone {
		return
	}

	message := "outbound UDP: blocked"
	if reason == outboundAllowMiss {
		message = "allowNet UDP: blocked (no matching rule)"
	}
	logrus.WithFields(logrus.Fields{
		"dst_ip":        addr,
		"dst_port":      port,
		"reason":        reason,
		"dropped_total": b.dropped,
	}).Info(message)
}
