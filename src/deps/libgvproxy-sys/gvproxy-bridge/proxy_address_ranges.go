package main

import (
	_ "embed"
	"net/netip"
	"strings"
)

//go:embed proxy_address_ranges.csv
var proxyRangeData string

type proxyAddressRange struct {
	prefix netip.Prefix
	public bool
}

var proxySpecialRanges, proxyIPv6Allocations = readProxyRanges(proxyRangeData)

func readProxyRanges(data string) (special, allocated []proxyAddressRange) {
	for _, line := range strings.Fields(data) {
		fields := strings.Split(line, ",")
		entry := proxyAddressRange{netip.MustParsePrefix(fields[1]), fields[2] == "allow"}
		if fields[0] == "allocation" {
			allocated = append(allocated, entry)
		} else {
			special = append(special, entry)
		}
	}
	return special, allocated
}

func proxyRangeAllows(ip netip.Addr, ranges []proxyAddressRange, unmatched bool) bool {
	best := -1
	allowed := unmatched
	for _, entry := range ranges {
		if entry.prefix.Bits() > best && entry.prefix.Contains(ip) {
			best = entry.prefix.Bits()
			allowed = entry.public
		}
	}
	return allowed
}

func (cfg proxyConnectorConfig) permitsAddress(ip netip.Addr, requireIPv4 bool) bool {
	if !ip.IsValid() || ip.Zone() != "" {
		return false
	}
	ip = ip.Unmap()
	if (requireIPv4 && !ip.Is4()) || !ip.IsGlobalUnicast() || ip.IsPrivate() {
		return false
	}
	for _, prefix := range cfg.protected {
		if prefix.Contains(ip) {
			return false
		}
	}
	return proxyRangeAllows(ip, proxySpecialRanges, true) &&
		(ip.Is4() || proxyRangeAllows(ip, proxyIPv6Allocations, false))
}
