package main

// allow_net_filter.go — AllowNet matcher shared by the TCP and UDP paths.
//
// Supports: exact IP, CIDR, exact hostname, wildcard hostname (*.example.com).
// IP/CIDR rules are checked directly against destination IPs, so they apply to
// both transports. Hostname rules need SNI/Host inspection (forked_tcp.go),
// which only TCP can do — UDP therefore denies hostname-only allowlists
// (forked_udp.go).

import (
	"net"
	"strings"

	logrus "github.com/sirupsen/logrus"
)

// AllowNetFilter checks outbound traffic against an allowlist.
// nil filter means no filtering (all traffic allowed).
type AllowNetFilter struct {
	exactIPs         map[[4]byte]bool
	cidrs            []*net.IPNet
	alwaysAllow      map[[4]byte]bool // internal IPs that should never be filtered
	exactHosts       map[string]bool  // "api.openai.com" → true
	wildcardSuffixes []string         // ".example.com"
	hasHostnameRules bool

	exactHostIPs      map[string][]net.IP // "api.openai.com" → resolved IPv4 set (egress pin)
	wildcardSuffixIPs map[string][]net.IP // ".example.com" → resolved IPv4 set (egress pin)
}

// NewAllowNetFilter parses allow_net rules into IP/CIDR and hostname categories.
// Returns nil if rules is empty (zero overhead fast path).
func NewAllowNetFilter(rules []string, internalIPs ...string) *AllowNetFilter {
	if len(rules) == 0 {
		return nil
	}

	f := &AllowNetFilter{
		exactIPs:    make(map[[4]byte]bool),
		alwaysAllow: make(map[[4]byte]bool),
		exactHosts:  make(map[string]bool),
	}

	// Internal IPs always allowed
	for _, ipStr := range internalIPs {
		if ipStr == "" {
			continue
		}
		if parsed := net.ParseIP(ipStr); parsed != nil {
			if ip4 := parsed.To4(); ip4 != nil {
				f.alwaysAllow[toIPv4Key(ip4)] = true
			}
		}
	}

	for _, rule := range rules {
		rule = strings.TrimSpace(rule)
		if rule == "" {
			continue
		}

		// Exact IP: "1.2.3.4"
		if ip := net.ParseIP(rule); ip != nil {
			if ip4 := ip.To4(); ip4 != nil {
				f.exactIPs[toIPv4Key(ip4)] = true
				logrus.WithField("ip", rule).Debug("allowNet: added exact IP")
			}
			continue
		}

		// CIDR: "10.0.0.0/8"
		if _, cidr, err := net.ParseCIDR(rule); err == nil {
			f.cidrs = append(f.cidrs, cidr)
			logrus.WithField("cidr", rule).Debug("allowNet: added CIDR")
			continue
		}

		// Hostname (strip port if present)
		host := rule
		if h, _, err := net.SplitHostPort(rule); err == nil {
			host = h
		}

		// Wildcard: *.example.com
		if strings.HasPrefix(host, "*.") {
			suffix := strings.ToLower(host[1:]) // ".example.com"
			f.wildcardSuffixes = append(f.wildcardSuffixes, suffix)
			f.hasHostnameRules = true
			logrus.WithField("wildcard", host).Debug("allowNet: added wildcard")
			continue
		}

		// Exact hostname
		f.exactHosts[strings.ToLower(host)] = true
		f.hasHostnameRules = true
		logrus.WithField("hostname", host).Debug("allowNet: added hostname")
	}

	logrus.WithFields(logrus.Fields{
		"exact_ips": len(f.exactIPs),
		"cidrs":     len(f.cidrs),
		"hostnames": len(f.exactHosts),
		"wildcards": len(f.wildcardSuffixes),
	}).Info("allowNet: filter initialized")

	return f
}

// MatchesIP checks if destIP is allowed by IP/CIDR rules or always-allow.
func (f *AllowNetFilter) MatchesIP(destIP net.IP) bool {
	ip4 := destIP.To4()
	if ip4 == nil {
		return false
	}
	key := toIPv4Key(ip4)
	if f.alwaysAllow[key] {
		return true
	}
	if f.exactIPs[key] {
		return true
	}
	for _, cidr := range f.cidrs {
		if cidr.Contains(ip4) {
			return true
		}
	}
	return false
}

// MatchesHostname checks if hostname is allowed by hostname rules.
func (f *AllowNetFilter) MatchesHostname(hostname string) bool {
	hostname = strings.ToLower(strings.TrimSuffix(hostname, "."))
	if hostname == "" {
		return false
	}
	if f.exactHosts[hostname] {
		return true
	}
	for _, suffix := range f.wildcardSuffixes {
		if strings.HasSuffix(hostname, suffix) {
			return true
		}
	}
	return false
}

// HasHostnameRules returns true if any hostname/wildcard rules exist.
func (f *AllowNetFilter) HasHostnameRules() bool {
	return f.hasHostnameRules
}

// SetResolvedHostIPs installs the gateway DNS resolution results for hostname
// rules, keyed the same way as exactHosts/wildcardSuffixes. The TCP forwarder
// uses these to pin the dialed IP to the hostname's own resolution.
func (f *AllowNetFilter) SetResolvedHostIPs(exact, wildcard map[string][]net.IP) {
	f.exactHostIPs = exact
	f.wildcardSuffixIPs = wildcard
}

// AllowHostToIP reports whether hostname is allow-listed AND destIP is one of
// the IPs the gateway DNS resolved for it (the egress pin). It is the single
// point that ties the guest-supplied hostname to the dialed IP, closing the
// domain-fronting decoupling that MatchesHostname alone leaves open. A
// hostname can be covered by an exact rule and one or more wildcards (or
// overlapping wildcards), so the check unions across every matching rule:
// destIP is allowed when any matching rule resolves it, independent of rule
// order, and fails closed only when none do.
func (f *AllowNetFilter) AllowHostToIP(hostname string, destIP net.IP) bool {
	hostname = strings.ToLower(strings.TrimSuffix(hostname, "."))
	if hostname == "" {
		return false
	}
	ip4 := destIP.To4()
	if ip4 == nil {
		return false
	}
	if f.exactHosts[hostname] && containsIPv4(f.exactHostIPs[hostname], ip4) {
		return true
	}
	for _, suffix := range f.wildcardSuffixes {
		if strings.HasSuffix(hostname, suffix) && containsIPv4(f.wildcardSuffixIPs[suffix], ip4) {
			return true
		}
	}
	return false
}

func containsIPv4(ips []net.IP, target net.IP) bool {
	for _, ip := range ips {
		if ip.Equal(target) {
			return true
		}
	}
	return false
}

func toIPv4Key(ip net.IP) [4]byte {
	ip4 := ip.To4()
	return [4]byte{ip4[0], ip4[1], ip4[2], ip4[3]}
}
