package main

// allow_net_filter.go — AllowNet matcher shared by the TCP and UDP paths.
//
// Supports: exact IP, CIDR, exact hostname, wildcard hostname (*.example.com).
// IP/CIDR rules are checked directly against destination IPs, so they apply to
// both transports. Hostname rules need SNI/Host inspection (forked_tcp.go),
// which only TCP can do — UDP therefore denies hostname-only allowlists
// (forked_udp.go). A hostname match authorizes the name alone: the gateway
// then dials the name itself (egress_dialer.go), so the filter never needs to
// know which addresses a name has.

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
			domain := canonicalHostname(host[2:])
			if domain == "" {
				logrus.WithField("rule", rule).Warn("allowNet: ignoring malformed wildcard rule")
				continue
			}
			f.wildcardSuffixes = append(f.wildcardSuffixes, "."+domain) // ".example.com"
			f.hasHostnameRules = true
			logrus.WithField("wildcard", host).Debug("allowNet: added wildcard")
			continue
		}

		// Exact hostname
		name := canonicalHostname(host)
		if name == "" {
			logrus.WithField("rule", rule).Warn("allowNet: ignoring malformed hostname rule")
			continue
		}
		f.exactHosts[name] = true
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
	hostname = canonicalHostname(hostname)
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

// canonicalHostname is the one spelling every hostname comparison uses: rules
// at parse time, the peeked SNI / Host header, and DNS question names. It
// lowercases, drops the FQDN trailing dot, and returns "" for anything that is
// not a name — empty input and IP literals (bare or bracketed). An IP literal
// in a Host header or SNI must never be treated as a hostname: a hostname
// grants egress to wherever the name resolves, and a literal would let the
// guest pick that address itself.
func canonicalHostname(raw string) string {
	name := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(raw), "."))
	if name == "" {
		return ""
	}
	if net.ParseIP(strings.Trim(name, "[]")) != nil {
		return ""
	}
	return name
}

func toIPv4Key(ip net.IP) [4]byte {
	ip4 := ip.To4()
	return [4]byte{ip4[0], ip4[1], ip4[2], ip4[3]}
}
