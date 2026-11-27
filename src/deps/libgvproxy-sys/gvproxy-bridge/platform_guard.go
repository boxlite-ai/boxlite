package main

import (
	"fmt"
	"net/netip"
	"strings"
)

// The platform guard is fixed by host startup and shared across Box revisions.
type platformGuard struct {
	protected []netip.Prefix
	cloud     bool
	guest     netip.Prefix
}

func compilePlatformGuard(values []string, cloud bool, subnet string) (platformGuard, error) {
	guard := platformGuard{cloud: cloud}
	if cloud {
		guest, err := netip.ParsePrefix(subnet)
		if err != nil || !guest.Addr().Is4() {
			return platformGuard{}, fmt.Errorf("Cloud platform guard requires an IPv4 guest subnet")
		}
		guard.guest = guest.Masked()
	}
	protected, err := ipv4ProtectedPrefixes(values)
	guard.protected = protected
	return guard, err
}

func (guard platformGuard) denies(address netip.Addr) bool {
	address = address.Unmap()
	for _, prefix := range guard.protected {
		if prefix.Contains(address) {
			return true
		}
	}
	if !guard.cloud {
		return false
	}
	if !address.Is4() || guard.guest.Contains(address) {
		return true
	}
	_, restricted := unroutableEgress(address.AsSlice())
	return restricted
}

func (guard platformGuard) requiresCheckedUDP() bool {
	return guard.cloud || len(guard.protected) != 0
}

func ipv4ProtectedPrefixes(values []string) ([]netip.Prefix, error) {
	var prefixes []netip.Prefix
	for i, value := range values {
		prefix, err := netip.ParsePrefix(strings.TrimSpace(value))
		if err != nil {
			return nil, fmt.Errorf("invalid platform-protected CIDR at index %d", i)
		}
		address, bits := prefix.Addr(), prefix.Bits()
		if address.Is4In6() && bits >= 96 {
			address, bits = address.Unmap(), bits-96
		}
		if !address.Is4() {
			return nil, fmt.Errorf("platform-protected CIDR at index %d must represent an IPv4 range", i)
		}
		prefixes = append(prefixes, netip.PrefixFrom(address, bits).Masked())
	}
	return prefixes, nil
}
