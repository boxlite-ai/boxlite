package main

// egress_dialer.go — checked destinations and the selected TCP transport.
//
// When SNI/Host inspection matches a hostname rule, the gateway resolves
// that name through its configured resolver and checks each answer before
// dialing. This uses the current addresses regardless of the guest's
// destination IP or /etc/hosts configuration.
//
// Address-authorized flows retain the guest's pre-NAT policy address and
// dial the translated address. Both paths enter the same transport boundary.

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"strconv"
	"time"

	logrus "github.com/sirupsen/logrus"
)

// resolveFunc resolves hostnames through the selected profile. Local uses
// systemResolve and Cloud uses its operator-approved endpoints.
type resolveFunc func(ctx context.Context, host string) ([]net.IP, error)

// dialFunc is the socket seam, shaped like net.Dialer.DialContext.
type dialFunc func(ctx context.Context, network, addr string) (net.Conn, error)

// egressTarget separates the business destination from its approved socket
// address. A transport receives a literal IPv4 address and must not resolve
// Hostname again; PolicyIP retains the guest's address before NAT or DNS.
type egressTarget struct {
	Hostname       string
	PolicyIP       netip.Addr
	ConnectionIP   netip.Addr
	Port           uint16
	Protocol       string
	PolicyRevision string
}

func (t egressTarget) address() string {
	return net.JoinHostPort(t.ConnectionIP.String(), strconv.Itoa(int(t.Port)))
}

// connectFunc must honor context cancellation and release setup resources on
// failure. A successful connection becomes the forwarder's responsibility.
type connectFunc func(context.Context, egressTarget) (net.Conn, error)

// upstreamDial is what the TCP forwarder and the MITM proxy consume: a dial
// already bound to one destination, so neither needs to know whether that
// destination is a name or an address.
type upstreamDial func(ctx context.Context) (net.Conn, error)

// egressDialer owns controlled resolution and one selected transport. Configure
// its seams before publishing it to forwarders; flows retain that instance.
type egressDialer struct {
	guard     platformGuard
	filter    *AllowNetFilter // an IP/CIDR rule may re-admit an address unroutableEgress refuses
	boxSubnet *net.IPNet      // the virtual network itself is never a by-name destination
	resolve   resolveFunc
	dial      dialFunc
	connect   connectFunc // nil selects the direct socket dialer
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

// hostResolver uses the Local host's system resolution. Local gvproxy uses
// the same host DNS configuration for guest queries and hostname routing.
var hostResolver = &net.Resolver{PreferGo: false}

// systemResolve is the default Local production resolver. A
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
func (d *egressDialer) byName(target egressTarget) upstreamDial {
	return func(ctx context.Context) (net.Conn, error) {
		return d.DialHost(ctx, target)
	}
}

// byAddress binds an address-authorized destination (an IP/CIDR match, or
// the NAT-translated host alias), dialed exactly as the guest addressed it.
func (d *egressDialer) byAddress(target egressTarget) upstreamDial {
	return func(ctx context.Context) (net.Conn, error) {
		ctx, cancel := context.WithTimeout(ctx, upstreamDialTimeout)
		defer cancel()
		return d.dialTarget(ctx, "tcp", target)
	}
}

func (d *egressDialer) dialTarget(ctx context.Context, network string, target egressTarget) (net.Conn, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if deadline, ok := ctx.Deadline(); ok && !time.Now().Before(deadline) {
		return nil, context.DeadlineExceeded
	}
	if d.guard.denies(target.ConnectionIP) {
		return nil, fmt.Errorf("egress destination denied by platform")
	}
	target.Protocol = "tcp"
	if d.connect != nil {
		return d.connect(ctx, target)
	}
	return d.dial(ctx, network, target.address())
}

// DialHost uses the configured resolver and tries permitted IPv4 answers in
// order until one connects. The guest network and allow_net rules use IPv4.
func (d *egressDialer) DialHost(ctx context.Context, target egressTarget) (net.Conn, error) {
	return d.dialHost(ctx, target, nil)
}

func (d *egressDialer) dialHost(ctx context.Context, target egressTarget, check func(netip.Addr) outboundReason) (net.Conn, error) {
	// One bound for the whole operation: the host lookup plus every candidate
	// dial. It lives here rather than at the call site because the MITM path
	// hands this dial to http.Transport, whose DialContext carries only the
	// proxied request's context — without this, a stalled resolver, or several
	// candidates each taking the dialer's own timeout, would have no ceiling.
	// Cancelling on return does not affect a connection already established.
	ctx, cancel := context.WithTimeout(ctx, upstreamDialTimeout)
	defer cancel()

	deadline, _ := ctx.Deadline() // always set: WithTimeout above just set one

	ips, err := d.candidates(ctx, target.Hostname, check)
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
		target.ConnectionIP = netip.AddrFrom4([4]byte(ip.To4()))
		conn, err := d.dialTarget(attemptCtx, "tcp4", target)
		cancelAttempt()
		if err == nil {
			return conn, nil
		}
		lastErr = err
	}
	return nil, fmt.Errorf("dial %s:%d: %w", target.Hostname, target.Port, lastErr)
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

func (d *egressDialer) candidates(ctx context.Context, hostname string, check func(netip.Addr) outboundReason) ([]net.IP, error) {
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
		address := netip.AddrFrom4([4]byte(ip4))
		if d.guard.denies(address) {
			logrus.WithField("reason", outboundPlatformDeny).Debug("platform protected DNS candidate denied")
			continue
		}
		var reason string
		if check != nil {
			if decision := check(address); decision != outboundAllowed {
				reason = string(decision)
			}
		} else {
			reason, _ = d.refuses(ip4)
		}
		if reason != "" {
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

func (s *outboundSnapshot) egressAddressFacts(ip netip.Addr, candidate bool) outboundAddressFacts {
	ip = ip.Unmap()
	if !ip.Is4() {
		return outboundAddressFacts{address: ip, platformDenied: true}
	}
	reason, restricted := unroutableEgress(ip.AsSlice())
	local := reason == "loopback" || reason == "private" || reason == "cgnat"
	return outboundAddressFacts{
		address: ip,
		platformDenied: s.dialer.guard.denies(ip) || (restricted && !local) ||
			(candidate && s.dialer.boxSubnet.Contains(ip.AsSlice())),
		restrictedLocal: candidate && local,
	}
}

// refuses applies the legacy Box policy to a resolved address. The platform
// guard checks every candidate before this policy.
//
// The Box subnet and link-local destinations are denied even with an explicit
// IP or CIDR rule. With a non-empty allowlist, other restricted destinations
// also require a matching IP or CIDR rule. For example, adding 10.0.0.0/8
// alongside db.example.internal can allow a private answer on Local.
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
