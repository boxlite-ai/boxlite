package main

// tcp_filter.go — AllowNet matcher for TCP-level filtering.
//
// Supports: exact IP, CIDR, exact hostname, wildcard hostname (*.example.com).
// IP/CIDR rules are checked directly against destination IPs.
// Hostname rules are checked via SNI/Host header inspection (see forked_tcp.go).

import (
	"net"
	"strings"

	logrus "github.com/sirupsen/logrus"
)

// TCPFilter checks outbound TCP connections against an allowlist.
// nil filter means no filtering (all traffic allowed).
type TCPFilter struct {
	exactIPs         map[[4]byte]bool
	cidrs            []*net.IPNet
	alwaysAllow      map[[4]byte]bool // internal IPs that should never be filtered
	exactHosts       map[string]bool  // "api.openai.com" → true
	wildcardSuffixes []string         // ".example.com"
	hasHostnameRules bool

	// resolvedHostIPs are the IPs the allow_net DNS sinkhole resolved for exact
	// hostname rules — i.e. exactly the addresses the guest receives when it
	// resolves an allowed host. Used only to bind the SNI-inspection path to a
	// real destination IP (see AllowsConnection); kept separate from exactIPs so
	// it does not widen which ports decideTCPRoute permits.
	resolvedHostIPs map[[4]byte]bool
	// resolve looks up a hostname's IPs at connection time, for wildcard
	// subdomains that are not pre-resolved. Injectable for tests.
	resolve func(string) ([]net.IP, error)
}

// NewTCPFilter parses allow_net rules into IP/CIDR and hostname categories.
// Returns nil if rules is empty (zero overhead fast path).
func NewTCPFilter(rules []string, internalIPs ...string) *TCPFilter {
	if len(rules) == 0 {
		return nil
	}

	f := &TCPFilter{
		exactIPs:        make(map[[4]byte]bool),
		alwaysAllow:     make(map[[4]byte]bool),
		exactHosts:      make(map[string]bool),
		resolvedHostIPs: make(map[[4]byte]bool),
		resolve:         defaultResolveHost,
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
				logrus.WithField("ip", rule).Debug("allowNet TCP: added exact IP")
			}
			continue
		}

		// CIDR: "10.0.0.0/8"
		if _, cidr, err := net.ParseCIDR(rule); err == nil {
			f.cidrs = append(f.cidrs, cidr)
			logrus.WithField("cidr", rule).Debug("allowNet TCP: added CIDR")
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
			logrus.WithField("wildcard", host).Debug("allowNet TCP: added wildcard")
			continue
		}

		// Exact hostname
		f.exactHosts[strings.ToLower(host)] = true
		f.hasHostnameRules = true
		logrus.WithField("hostname", host).Debug("allowNet TCP: added hostname")
	}

	logrus.WithFields(logrus.Fields{
		"exact_ips": len(f.exactIPs),
		"cidrs":     len(f.cidrs),
		"hostnames": len(f.exactHosts),
		"wildcards": len(f.wildcardSuffixes),
	}).Info("allowNet TCP: filter initialized")

	return f
}

// MatchesIP checks if destIP is allowed by IP/CIDR rules or always-allow.
func (f *TCPFilter) MatchesIP(destIP net.IP) bool {
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
func (f *TCPFilter) MatchesHostname(hostname string) bool {
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
func (f *TCPFilter) HasHostnameRules() bool {
	return f.hasHostnameRules
}

// WithResolvedHostIPs records the IPs the DNS sinkhole resolved for exact
// hostname rules so the SNI-inspection path can bind a connection's destination
// IP to a real address for the claimed host. Returns the filter for chaining.
func (f *TCPFilter) WithResolvedHostIPs(ips []net.IP) *TCPFilter {
	if f == nil {
		return f
	}
	for _, ip := range ips {
		if ip4 := ip.To4(); ip4 != nil {
			f.resolvedHostIPs[toIPv4Key(ip4)] = true
		}
	}
	return f
}

// WithResolver overrides the connection-time hostname resolver (used for
// wildcard subdomains). Returns the filter for chaining.
func (f *TCPFilter) WithResolver(resolve func(string) ([]net.IP, error)) *TCPFilter {
	if f != nil && resolve != nil {
		f.resolve = resolve
	}
	return f
}

func defaultResolveHost(host string) ([]net.IP, error) {
	return net.LookupIP(host)
}

// AllowsConnection decides whether a TLS/HTTP connection carrying the given
// guest-supplied SNI/Host may proceed to destIP. It closes the allow_net bypass
// where the SNI alone was trusted: the SNI must match a rule AND destIP must be
// a real address for an allowed host. For exact hosts the destination must be
// one of the sinkhole-resolved IPs (or an explicitly allow-listed IP); for
// wildcard rules — whose subdomains are not pre-resolved — the host is resolved
// at connection time and destIP must be in the result.
func (f *TCPFilter) AllowsConnection(hostname string, destIP net.IP) bool {
	if f == nil {
		return true // no allowlist → no filtering
	}
	if !f.MatchesHostname(hostname) {
		return false // SNI/Host not in the allowlist
	}
	if f.matchesIPOrResolvedHost(destIP) {
		return true // destination is an explicitly allowed or sinkhole-resolved IP
	}
	// SNI matched but the IP was not pre-bound. Only legitimate for wildcard
	// subdomains (not pre-resolved): bind by resolving the SNI now.
	if f.hostnameMatchesWildcard(hostname) {
		return f.resolvesTo(hostname, destIP)
	}
	return false
}

func (f *TCPFilter) matchesIPOrResolvedHost(destIP net.IP) bool {
	if f.MatchesIP(destIP) {
		return true
	}
	if ip4 := destIP.To4(); ip4 != nil {
		return f.resolvedHostIPs[toIPv4Key(ip4)]
	}
	return false
}

func (f *TCPFilter) hostnameMatchesWildcard(hostname string) bool {
	hostname = strings.ToLower(strings.TrimSuffix(hostname, "."))
	for _, suffix := range f.wildcardSuffixes {
		if strings.HasSuffix(hostname, suffix) {
			return true
		}
	}
	return false
}

func (f *TCPFilter) resolvesTo(hostname string, destIP net.IP) bool {
	hostname = strings.ToLower(strings.TrimSuffix(hostname, "."))
	ips, err := f.resolve(hostname)
	if err != nil {
		logrus.WithFields(logrus.Fields{"hostname": hostname, "error": err}).
			Warn("allowNet TCP: connect-time resolution failed; blocking")
		return false
	}
	for _, ip := range ips {
		if ip.Equal(destIP) {
			return true
		}
	}
	return false
}

func toIPv4Key(ip net.IP) [4]byte {
	ip4 := ip.To4()
	return [4]byte{ip4[0], ip4[1], ip4[2], ip4[3]}
}
