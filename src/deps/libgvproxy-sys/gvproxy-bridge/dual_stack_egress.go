package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"time"
)

type familyResolver func(context.Context, string, string) ([]net.IP, error)

type ipv6LinkPlan struct {
	Interface string     `json:"interface"`
	Guest     netip.Addr `json:"guest"`
	Gateway   netip.Addr `json:"gateway"`
}

func (plan ipv6LinkPlan) prefix() (netip.Prefix, error) {
	if plan.Interface != "eth0" || !plan.Guest.Is6() || !plan.Gateway.Is6() ||
		plan.Guest.Zone() != "" || plan.Gateway.Zone() != "" ||
		plan.Guest.As16()[0] != 0xfd || plan.Guest == plan.Gateway {
		return netip.Prefix{}, fmt.Errorf("invalid IPv6 link plan")
	}
	prefix := netip.PrefixFrom(plan.Gateway, 64)
	if !prefix.Contains(plan.Guest) || plan.Gateway == prefix.Masked().Addr() ||
		plan.Guest == prefix.Masked().Addr() {
		return netip.Prefix{}, fmt.Errorf("IPv6 link endpoints must be hosts in one ULA /64")
	}
	return prefix, nil
}

func sameIPv6Plan(left, right *ipv6LinkPlan) bool {
	return left == right || (left != nil && right != nil && *left == *right)
}

var publicIPv6 = netip.MustParsePrefix("2000::/3")

var specialUseIPv6 = []netip.Prefix{
	netip.MustParsePrefix("2001::/23"), // IETF protocol assignments, including Teredo.
	netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("2002::/16"), // 6to4.
	netip.MustParsePrefix("3fff::/20"),
}

func (d *egressDialer) nativeEligible(address netip.Addr) bool {
	return d.nativeReady != nil && d.nativeReady() && !d.nativeSubnet.Contains(address) && globalEgressIPv6(address)
}

func globalEgressIPv6(address netip.Addr) bool {
	if !publicIPv6.Contains(address) || address.Zone() != "" {
		return false
	}
	for _, reserved := range specialUseIPv6 {
		if reserved.Contains(address) {
			return false
		}
	}
	return true
}

func socketFamily(protocol string, address netip.Addr) string {
	if address.Is4() {
		return protocol + "4"
	}
	return protocol + "6"
}

func (d *egressDialer) lookup(ctx context.Context, hostname string) ([]net.IP, error) {
	if d.nativeReady == nil || !d.nativeReady() {
		return d.resolve(ctx, hostname)
	}
	budget := cloudDNSLookupTimeout
	if deadline, ok := ctx.Deadline(); ok {
		budget = min(budget, time.Until(deadline)/2)
	}
	if budget <= 0 {
		return nil, context.DeadlineExceeded
	}
	lookup, cancel := context.WithTimeout(ctx, budget)
	defer cancel()

	type result struct {
		addresses []net.IP
		err       error
	}
	results := make(chan result, 2)
	for _, family := range []string{"ip4", "ip6"} {
		go func() {
			addresses, err := d.resolveFamily(lookup, family, hostname)
			if lookup.Err() != nil {
				addresses = nil
			}
			results <- result{addresses, err}
		}()
	}
	var addresses []net.IP
	var lookupErr error
	for range 2 {
		select {
		case answer := <-results:
			addresses = append(addresses, answer.addresses...)
			lookupErr = errors.Join(lookupErr, answer.err)
		case <-lookup.Done():
			// A finished family remains usable when the other family stalls.
			for pending := len(results); pending > 0; pending-- {
				answer := <-results
				addresses = append(addresses, answer.addresses...)
				lookupErr = errors.Join(lookupErr, answer.err)
			}
			lookupErr = errors.Join(lookupErr, lookup.Err())
			return completedLookup(ctx, hostname, addresses, lookupErr)
		}
	}
	return completedLookup(ctx, hostname, addresses, lookupErr)
}

func completedLookup(ctx context.Context, hostname string, addresses []net.IP, err error) ([]net.IP, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if len(addresses) != 0 {
		return addresses, nil
	}
	if err != nil {
		return nil, err
	}
	return nil, fmt.Errorf("no address records for %s", hostname)
}
