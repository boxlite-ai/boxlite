package main

import (
	"context"
	"fmt"
	"net/netip"
	"strings"
	"time"
)

// The platform guard is fixed by host startup and shared across Box revisions.
type platformGuard struct {
	protected []netip.Prefix
	cloud     bool
	scope     *cloudScope
	uplink    cloudIPv6Uplink
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
	if address.Is6() {
		return guard.uplink.device == "" || !globalEgressIPv6(address)
	}
	if !address.Is4() || guard.guest.Contains(address) {
		return true
	}
	_, restricted := unroutableEgress(address.AsSlice())
	return restricted
}

func (guard platformGuard) supportsIPv6() bool {
	if !guard.cloud {
		return true
	}
	if guard.uplink.device == "" || guard.scope == nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	uplink, err := guard.scope.ipv6Uplink(ctx)
	return err == nil && uplink == guard.uplink && uplink.checkRoute(ctx, cloudIPv6Probe) == nil
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
