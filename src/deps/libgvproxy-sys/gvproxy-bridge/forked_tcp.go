package main

// forked_tcp.go — TCP forwarder with AllowNet filtering + SNI/Host inspection.
//
// Fork of gvisor-tap-vsock@v0.8.7/pkg/services/forwarder/tcp.go.
// Two paths:
//   - Standard: IP/CIDR match or no filter → upstream flow (Dial → Accept → relay)
//   - Inspect:  port 443/80 with hostname rules → Accept → Peek SNI/Host → decide → Dial → relay
//
// What the inspect path dials depends on what authorized the connection. An
// IP/CIDR match dials the address the guest chose (NAT applied, as upstream
// does). A hostname match dials the NAME: the gateway resolves it itself and
// the guest's destination address cannot select the upstream socket
// (egress_dialer.go). A secret host is MITM'd and likewise dialed by name.

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/netip"
	"sync"

	"github.com/containers/gvisor-tap-vsock/pkg/tcpproxy"
	logrus "github.com/sirupsen/logrus"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/adapters/gonet"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
	"gvisor.dev/gvisor/pkg/tcpip/transport/tcp"
	"gvisor.dev/gvisor/pkg/waiter"
)

// TCPWithFilter creates a TCP forwarder that checks the filter before allowing
// outbound connections. For port 443/80 with hostname rules, it inspects
// TLS SNI / HTTP Host headers to match against the allowlist.
// linkLocalSubnet is 169.254.0.0/16, parsed once at init (not per-packet).
var linkLocalSubnet tcpip.Subnet

type tcpRoute int

const (
	tcpRouteBlock tcpRoute = iota
	tcpRouteStandardForward
	tcpRouteInspect
)

func init() {
	_, linkLocalNet, err := net.ParseCIDR("169.254.0.0/16")
	if err != nil {
		panic("failed to parse link-local CIDR: " + err.Error())
	}
	var subnetErr error
	linkLocalSubnet, subnetErr = tcpip.NewSubnet(
		tcpip.AddrFromSlice(linkLocalNet.IP),
		tcpip.MaskFromBytes(linkLocalNet.Mask),
	)
	if subnetErr != nil {
		panic("failed to create link-local subnet: " + subnetErr.Error())
	}
}

func decideTCPRoute(destIP net.IP, destPort uint16, filter *AllowNetFilter, secretMatcher *SecretHostMatcher) tcpRoute {
	if filter == nil {
		if secretMatcher != nil && destPort == 443 {
			return tcpRouteInspect
		}
		return tcpRouteStandardForward
	}

	// Secret injection needs SNI even if the destination IP is broadly allowed.
	if secretMatcher != nil && destPort == 443 {
		return tcpRouteInspect
	}

	// Normalize the gVisor-provided IP into canonical IPv4 form before matching.
	if ip4 := destIP.To4(); ip4 != nil && filter.MatchesIP(ip4) {
		return tcpRouteStandardForward
	}

	if filter.HasHostnameRules() && (destPort == 443 || destPort == 80) {
		return tcpRouteInspect
	}

	return tcpRouteBlock
}

func resolveTCPDestination(localAddress tcpip.Address, nat map[tcpip.Address]tcpip.Address,
	natLock *sync.Mutex) (net.IP, tcpip.Address) {
	policyAddress := localAddress
	dialAddress := localAddress

	natLock.Lock()
	if replaced, ok := nat[localAddress]; ok {
		dialAddress = replaced
	}
	natLock.Unlock()

	addr4 := policyAddress.As4()
	return net.IP(addr4[:]), dialAddress
}

// tcpInspectRoute is the post-peek decision: what to do once the guest's
// SNI/Host is known. decideTCPRoute sends :443/:80 here precisely because it
// cannot decide without the hostname.
type tcpInspectRoute int

const (
	tcpInspectBlock tcpInspectRoute = iota
	tcpInspectForward
	tcpInspectMitm
)

// tcpEgress says which destination the gateway dials for an allowed
// connection: the guest's address, or the peeked name.
type tcpEgress int

const (
	egressByAddress tcpEgress = iota
	egressByName
)

// decideTCPInspectRoute resolves a peeked connection. A secret host is MITM'd
// (HTTPS only) and dialed by name, so a credential never travels to an
// address the guest picked. Otherwise an IP/CIDR match forwards to the guest's
// address — the host.boxlite.internal NAT lives on that path — and a hostname
// match forwards by name. hostname is already canonical.
func decideTCPInspectRoute(hostname string, destIP net.IP, destPort uint16,
	filter *AllowNetFilter, secretMatcher *SecretHostMatcher) (tcpInspectRoute, tcpEgress) {

	if destPort == 443 && secretMatcher != nil && hostname != "" && secretMatcher.Matches(hostname) {
		return tcpInspectMitm, egressByName
	}
	// With an empty Box allowlist, select direct routing. The dialer still
	// checks the destination against the platform guard.
	if filter == nil {
		return tcpInspectForward, egressByAddress
	}
	if filter.MatchesIP(destIP) {
		return tcpInspectForward, egressByAddress
	}
	if filter.MatchesHostname(hostname) {
		return tcpInspectForward, egressByName
	}
	return tcpInspectBlock, egressByAddress
}

func TCPWithFilter(s *stack.Stack, nat map[tcpip.Address]tcpip.Address,
	natLock *sync.Mutex, ec2MetadataAccess bool, snapshot snapshotSource, inspectionSlots chan struct{},
	ca *BoxCA, secretMatcher *SecretHostMatcher) *tcp.Forwarder {

	return tcp.NewForwarder(s, 0, 10, func(r *tcp.ForwarderRequest) {
		current := snapshot()
		if current.policy.Mode == "disabled" {
			r.Complete(true)
			return
		}
		filter, dialer := current.filter, current.dialer
		localAddress := r.ID().LocalAddress
		if localAddress.Len() != net.IPv4len {
			r.Complete(true)
			return
		}

		if !ec2MetadataAccess && linkLocalSubnet.Contains(localAddress) {
			r.Complete(true)
			return
		}

		// Policy checks must see the pre-NAT destination (for example the host alias IP),
		// while the actual outbound dial uses any NAT-translated address (for example 127.0.0.1).
		destIP, dialAddress := resolveTCPDestination(localAddress, nat, natLock)
		destPort := r.ID().LocalPort
		target := egressTarget{
			PolicyIP:       netip.AddrFrom4(localAddress.As4()),
			ConnectionIP:   netip.AddrFrom4(dialAddress.As4()),
			Port:           destPort,
			Protocol:       "tcp",
			PolicyRevision: current.revision,
		}
		if current.extended != nil {
			forwardExtendedTCP(r, target, current, inspectionSlots, ca, secretMatcher)
			return
		}
		if dialer.guard.denies(target.PolicyIP) {
			logrus.WithField("reason", outboundPlatformDeny).Debug("TCP original destination denied")
			r.Complete(true)
			return
		}

		switch decideTCPRoute(destIP, destPort, filter, secretMatcher) {
		case tcpRouteStandardForward:
			standardForward(r, dialer.byAddress(target))
			return
		case tcpRouteInspect:
			inspectAndForward(r, target, filter, dialer, ca, secretMatcher)
			return
		default:
			// No matching rule: block
			logrus.WithFields(logrus.Fields{
				"dst_ip":   destIP,
				"dst_port": destPort,
			}).Info("allowNet TCP: blocked (no matching rule)")
			r.Complete(true) // RST
		}
	})
}

// standardForward is the upstream flow: Dial → CreateEndpoint → relay.
func standardForward(r *tcp.ForwarderRequest, dial upstreamDial) {
	outbound, err := dial(context.Background())
	if err != nil {
		logrus.Tracef("outbound dial = %v", err)
		r.Complete(true)
		return
	}

	guest := openGuestTCP(r)
	if guest == nil {
		outbound.Close()
		return
	}
	relayTCP(guest, outbound)
}

func relayTCP(guest, outbound net.Conn) {
	remote := tcpproxy.DialProxy{
		DialContext: func(_ context.Context, _, _ string) (net.Conn, error) {
			return outbound, nil
		},
	}
	remote.HandleConn(guest)
}

func openGuestTCP(r *tcp.ForwarderRequest) net.Conn {
	var wq waiter.Queue
	ep, tcpErr := r.CreateEndpoint(&wq)
	r.Complete(false)
	if tcpErr != nil {
		if _, ok := tcpErr.(*tcpip.ErrConnectionRefused); ok {
			logrus.Debugf("r.CreateEndpoint() = %v", tcpErr)
		} else {
			logrus.Errorf("r.CreateEndpoint() = %v", tcpErr)
		}
		return nil
	}
	return gonet.NewTCPConn(&wq, ep)
}

// inspectAndForward accepts the guest before deciding where to connect.
func inspectAndForward(r *tcp.ForwarderRequest, target egressTarget,
	filter *AllowNetFilter, dialer *egressDialer, ca *BoxCA, secretMatcher *SecretHostMatcher) {
	destIP := net.IP(target.PolicyIP.AsSlice())
	destPort := target.Port
	guestConn := openGuestTCP(r)
	if guestConn == nil {
		return
	}

	// Step 2: Peek to extract hostname (non-consuming read via bufio.Reader).
	// Canonicalized once here; an IP literal in SNI/Host becomes "" and can
	// only be authorized by an IP rule.
	br := bufio.NewReaderSize(guestConn, 16384)
	var hostname string
	if destPort == 443 {
		hostname = peekClientHelloSNI(br)
	} else {
		hostname = peekHTTPHost(br)
	}
	hostname = canonicalHostname(hostname)
	target.Hostname = hostname

	// Step 3: One decision, covering every outcome. Wrapping the guest here
	// rather than once per branch keeps the peeked bytes replayable on
	// whichever branch runs.
	bufferedGuest := &bufferedConn{Conn: guestConn, reader: br}
	route, egress := decideTCPInspectRoute(hostname, destIP, destPort, filter, secretMatcher)

	var dial upstreamDial
	var dst string
	if egress == egressByName {
		dial = dialer.byName(target)
		dst = fmt.Sprintf("%s:%d", hostname, destPort)
	} else {
		dial = dialer.byAddress(target)
		dst = target.address()
	}
	fields := logrus.Fields{
		"dst":      dst,
		"dst_ip":   destIP,
		"hostname": hostname,
		"egress":   egressName(egress),
	}

	switch route {
	case tcpInspectMitm:
		secrets := secretMatcher.SecretsForHost(hostname)
		logrus.WithFields(logrus.Fields{
			"hostname":    hostname,
			"num_secrets": len(secrets),
		}).Debug("MITM: intercepting for secret injection")
		mitmAndForward(bufferedGuest, hostname, dial, ca, secrets)
		return
	case tcpInspectForward:
		logrus.WithFields(fields).Debug("allowNet TCP: allowed")
	default:
		logrus.WithFields(fields).Info("allowNet TCP: blocked (no matching IP or hostname rule)")
		guestConn.Close()
		return
	}

	// Both bound dialers own the setup deadline, including MITM redials.
	outbound, err := dial(context.Background())
	if err != nil {
		logrus.WithFields(fields).WithField("error", err).Trace("allowNet TCP: upstream dial failed")
		guestConn.Close()
		return
	}

	relayTCP(bufferedGuest, outbound)
}

func egressName(e tcpEgress) string {
	if e == egressByName {
		return "by-name"
	}
	return "by-address"
}

// bufferedConn wraps a net.Conn with a bufio.Reader for Read operations.
// This ensures peeked bytes (from SNI/Host inspection) are replayed to the
// upstream server during the relay phase.
type bufferedConn struct {
	net.Conn
	reader io.Reader
}

func (c *bufferedConn) Read(p []byte) (int, error) {
	return c.reader.Read(p)
}
