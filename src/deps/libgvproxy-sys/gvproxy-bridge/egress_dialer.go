package main

// egress_dialer.go — how the gateway reaches a destination that allow_net
// names by hostname.
//
// A hostname rule authorizes a NAME, never an address the guest chose. Once
// SNI/Host inspection (forked_tcp.go) has matched the name, the gateway
// resolves it itself through the host resolver and dials what it gets; the
// guest's destination IP is discarded. That is what makes the hostname the
// only authorization input: a guest that edits /etc/hosts or hard-codes an
// attacker's address while presenting an allowed SNI still lands on the real
// host, and a destination whose address changes after the box started is
// reached at whatever it resolves to now.
//
// Destinations covered by an IP/CIDR rule keep dialing the guest's address —
// that path also carries the host.boxlite.internal NAT (main.go) — so only
// hostname-authorized flows come through here.

import (
	"context"
	"fmt"
	"net"
	"strconv"
	"time"

	logrus "github.com/sirupsen/logrus"
)

// resolveFunc is the host-resolver seam: hostname → addresses. Production
// uses systemResolve; tests inject a deterministic one.
type resolveFunc func(ctx context.Context, host string) ([]net.IP, error)

// dialFunc is the socket seam, shaped like net.Dialer.DialContext.
type dialFunc func(ctx context.Context, network, addr string) (net.Conn, error)

// upstreamDial is what the TCP forwarder and the MITM proxy consume: a dial
// already bound to one destination, so neither needs to know whether that
// destination is a name or an address.
type upstreamDial func(ctx context.Context) (net.Conn, error)

// egressDialer resolves, classifies and dials hostname-authorized
// destinations. One instance per box.
type egressDialer struct {
	filter    *AllowNetFilter // an IP/CIDR rule may re-admit an address unroutableEgress refuses
	boxSubnet *net.IPNet      // the virtual network itself is never a by-name destination
	resolve   resolveFunc
	dial      dialFunc
}

func newEgressDialer(filter *AllowNetFilter, subnet string) (*egressDialer, error) {
	_, boxSubnet, err := net.ParseCIDR(subnet)
	if err != nil {
		return nil, fmt.Errorf("egress dialer: parse box subnet %q: %w", subnet, err)
	}
	return &egressDialer{
		filter:    filter,
		boxSubnet: boxSubnet,
		resolve:   systemResolve,
		dial:      (&net.Dialer{Timeout: upstreamDialTimeout}).DialContext,
	}, nil
}

// hostResolver is the host's own resolver (cgo / getaddrinfo, not Go's), the
// same one gvisor-tap-vsock forwards guest queries through, so what the guest
// was told and what the gateway dials come from one source.
var hostResolver = &net.Resolver{PreferGo: false}

// systemResolve is the production resolver every by-name path goes through. A
// var, not a func, so a test can substitute it before anything is constructed
// and observe a lookup made at box creation — the shape of the bug this design
// removed (see TestStartupPerformsNoDNSLookups).
var systemResolve resolveFunc = func(ctx context.Context, host string) ([]net.IP, error) {
	addrs, err := hostResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	ips := make([]net.IP, 0, len(addrs))
	for _, a := range addrs {
		ips = append(ips, a.IP)
	}
	return ips, nil
}

// byName binds a hostname-authorized destination for the forwarder.
func (d *egressDialer) byName(hostname string, port uint16) upstreamDial {
	return func(ctx context.Context) (net.Conn, error) {
		return d.DialHost(ctx, hostname, port)
	}
}

// dialAddress binds an address-authorized destination (an IP/CIDR match, or
// the NAT-translated host alias), dialed exactly as the guest addressed it.
func dialAddress(dial dialFunc, addr string) upstreamDial {
	return func(ctx context.Context) (net.Conn, error) {
		return dial(ctx, "tcp", addr)
	}
}

// DialHost resolves hostname on the host, drops addresses the box must not
// reach, and dials the survivors in order until one connects. IPv4 only: the
// guest network is IPv4-only (gvisor-tap-vsock virtualnetwork.go), and the
// gateway process is not, so an unforced dial could open IPv6 egress that no
// allow_net rule can express.
func (d *egressDialer) DialHost(ctx context.Context, hostname string, port uint16) (net.Conn, error) {
	// One bound for the whole operation: the host lookup plus every candidate
	// dial. It lives here rather than at the call site because the MITM path
	// hands this dial to http.Transport, whose DialContext carries only the
	// proxied request's context — without this, a stalled resolver, or several
	// candidates each taking the dialer's own timeout, would have no ceiling.
	// Cancelling on return does not affect a connection already established.
	ctx, cancel := context.WithTimeout(ctx, upstreamDialTimeout)
	defer cancel()

	deadline, _ := ctx.Deadline() // always set: WithTimeout above just set one

	ips, err := d.candidates(ctx, hostname)
	if err != nil {
		return nil, err
	}
	var lastErr error
	for i, ip := range ips {
		// The one stop condition, as net.dialSerial checks before each
		// address: the caller is gone, or the budget is spent — the derived
		// context reports both. Without it a canceled MITM request walks the
		// whole candidate list, every attempt failing on a context already
		// done.
		if err := ctx.Err(); err != nil {
			if lastErr == nil {
				lastErr = err
			}
			break
		}
		attemptCtx, cancelAttempt := context.WithDeadline(ctx,
			candidateDeadline(time.Now(), deadline, len(ips)-i))
		conn, err := d.dial(attemptCtx, "tcp4", net.JoinHostPort(ip.String(), strconv.Itoa(int(port))))
		cancelAttempt()
		if err == nil {
			return conn, nil
		}
		lastErr = err
	}
	return nil, fmt.Errorf("dial %s:%d: %w", hostname, port, lastErr)
}

// minCandidateDialWindow is net/dial.go's saneMinimum and means the same
// thing: below it, a few candidates with a usable window beat every candidate
// with a hopeless one, and the deadline cuts the list short. A var so a test
// can shrink it and observe the split without spending seconds of wall clock.
var minCandidateDialWindow = 2 * time.Second

// candidateDeadline gives one resolved address its share of what is left of
// the operation deadline, the way net.dialSerial splits a multi-address dial
// (go/src/net/dial.go:659, partialDeadline at :269). One deadline shared by
// every candidate instead lets a blackholed address — accepting nothing,
// refusing nothing — spend the whole budget, so each healthy address behind it
// is dialed with a context that is already done.
//
// The share is recomputed against the addresses still to try, so a candidate
// that fails fast hands its unused time to the rest.
func candidateDeadline(now, deadline time.Time, remaining int) time.Time {
	left := deadline.Sub(now)
	share := left / time.Duration(remaining)
	if share < minCandidateDialWindow {
		share = minCandidateDialWindow
		if left < minCandidateDialWindow {
			share = left
		}
	}
	return now.Add(share)
}

func (d *egressDialer) candidates(ctx context.Context, hostname string) ([]net.IP, error) {
	resolved, err := d.resolve(ctx, hostname)
	if err != nil {
		return nil, fmt.Errorf("resolve %s: %w", hostname, err)
	}
	var ips []net.IP
	for _, ip := range resolved {
		ip4 := ip.To4()
		if ip4 == nil {
			continue
		}
		if reason, refused := d.refuses(ip4); refused {
			logrus.WithFields(logrus.Fields{
				"hostname": hostname,
				"resolved": ip4,
				"reason":   reason,
			}).Info("allowNet TCP: blocked (resolved address unroutable)")
			continue
		}
		ips = append(ips, ip4)
	}
	if len(ips) == 0 {
		return nil, fmt.Errorf("resolve %s: no dialable IPv4 address", hostname)
	}
	return ips, nil
}

// refuses decides whether a resolved address may be dialed on the guest's
// behalf.
//
// The box's own subnet is never dialable by name: a name pointing at the
// gateway or the host alias would turn a hostname rule into a route back into
// the virtual network.
//
// Link-local is refused for every box, with or without an allow_net and
// whatever the rules say. The guest-addressed path blocks 169.254.0.0/16
// outright before any rule is consulted (forked_tcp.go, and Ec2MetadataAccess
// is never enabled), so a by-name dial must not be the one way to IMDS — not
// in secrets-only mode where there is no filter to consult, and not through an
// explicit CIDR rule either.
//
// The remaining classes unroutableEgress lists are refused only under an
// allow_net, since a box without one has unrestricted egress and reaches those
// addresses directly anyway, and an explicit IP or CIDR rule re-admits them:
// listing 10.0.0.0/8 next to db.example.internal is how a private destination
// is meant to be granted.
func (d *egressDialer) refuses(ip net.IP) (reason string, refused bool) {
	if d.boxSubnet.Contains(ip) {
		return "box-subnet", true
	}
	if ip.IsLinkLocalUnicast() {
		return "link-local", true
	}
	if d.filter == nil {
		return "", false
	}
	reason, refused = unroutableEgress(ip)
	if refused && d.filter.MatchesIP(ip) {
		return "", false
	}
	return reason, refused
}

// unroutableEgress classifies the IPv4 ranges a hostname must not silently
// resolve into: a public name that answers with a private, loopback or
// metadata address would otherwise turn "allow api.example.com" into access
// to the host's own network (the SSRF shape Smokescreen and every sandbox
// proxy guard against).
func unroutableEgress(ip net.IP) (reason string, refused bool) {
	switch {
	case ip.IsUnspecified() || ip[0] == 0:
		return "unspecified", true
	case ip.IsLoopback():
		return "loopback", true
	case ip.IsPrivate():
		return "private", true
	case ip.IsLinkLocalUnicast():
		return "link-local", true
	case ip[0] == 100 && ip[1]&0xc0 == 64:
		return "cgnat", true
	case ip.IsMulticast():
		return "multicast", true
	case ip.Equal(net.IPv4bcast):
		return "broadcast", true
	}
	return "", false
}
