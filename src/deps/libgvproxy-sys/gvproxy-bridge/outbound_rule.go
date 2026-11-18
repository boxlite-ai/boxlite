package main

import (
	"fmt"
	"net"
	"net/netip"
	"strconv"
	"strings"
)

type outboundRule struct {
	prefix    netip.Prefix
	name      string
	wildcard  bool
	port      uint16
	canonical string
}

func parseOutboundRule(input string) (outboundRule, error) {
	text := strings.TrimSpace(input)
	if rule, ok := outboundAddressRule(text); ok {
		return rule, nil
	}

	host, port, bracketed, ok := splitOutboundRule(text)
	if ok {
		if rule, ok := outboundAddressRule(host); ok {
			return rule.withPort(port), nil
		}
		name, wildcard := strings.CutPrefix(host, "*.")
		if !bracketed && validOutboundName(name) {
			name = strings.ToLower(name)
			canonical := name
			if wildcard {
				canonical = "*." + name
			}
			rule := outboundRule{name: name, wildcard: wildcard, canonical: canonical}
			return rule.withPort(port), nil
		}
	}
	return outboundRule{}, fmt.Errorf("invalid outbound rule %q", input)
}

func splitOutboundRule(text string) (host string, port uint16, bracketed, ok bool) {
	if !strings.ContainsAny(text, ":[]") {
		return text, 0, false, true
	}
	host, suffix, err := net.SplitHostPort(text)
	bracketed = strings.HasPrefix(text, "[")
	if err != nil || (bracketed && !strings.Contains(host, ":")) || !outboundDecimal(suffix) {
		return "", 0, false, false
	}
	value, err := strconv.ParseUint(suffix, 10, 16)
	if err != nil || value == 0 {
		return "", 0, false, false
	}
	return host, uint16(value), bracketed, true
}

func outboundAddressRule(text string) (outboundRule, bool) {
	if addr, err := netip.ParseAddr(text); err == nil && addr.Zone() == "" {
		addr = addr.Unmap()
		return outboundRule{prefix: netip.PrefixFrom(addr, addr.BitLen()), canonical: addr.String()}, true
	}
	prefix, err := netip.ParsePrefix(text)
	if err != nil {
		return outboundRule{}, false
	}
	if prefix.Addr().Is4In6() {
		if prefix.Bits() < 96 {
			return outboundRule{}, false
		}
		prefix = netip.PrefixFrom(prefix.Addr().Unmap(), prefix.Bits()-96)
	}
	prefix = prefix.Masked()
	return outboundRule{prefix: prefix, canonical: prefix.String()}, true
}

func (r outboundRule) withPort(port uint16) outboundRule {
	if port != 0 {
		r.port = port
		r.canonical = net.JoinHostPort(r.canonical, strconv.Itoa(int(port)))
	}
	return r
}

func validOutboundName(name string) bool {
	if len(name) == 0 || len(name) > 253 {
		return false
	}
	labels := strings.Split(name, ".")
	allNumeric := len(labels) == 4
	for _, label := range labels {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for i := range len(label) {
			c := label[i]
			if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-') {
				return false
			}
		}
		allNumeric = allNumeric && outboundDecimal(label)
	}
	return !allNumeric
}

func outboundDecimal(text string) bool {
	if text == "" {
		return false
	}
	for i := range len(text) {
		if text[i] < '0' || text[i] > '9' {
			return false
		}
	}
	return true
}

func outboundObservedName(raw string) string {
	name := strings.TrimSuffix(strings.TrimSpace(raw), ".")
	if !validOutboundName(name) {
		return ""
	}
	return strings.ToLower(name)
}

func (r outboundRule) portMatches(port uint16) bool {
	return r.port == 0 || r.port == port
}

func (r outboundRule) matches(ip netip.Addr, name string, port uint16) bool {
	if !r.portMatches(port) {
		return false
	}
	if r.prefix.IsValid() {
		return r.prefix.Contains(ip)
	}
	if name == "" {
		return false
	}
	if r.wildcard {
		return strings.HasSuffix(name, "."+r.name)
	}
	return r.name == name
}
