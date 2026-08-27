package main

// dns_filter.go — DNS sinkhole for network allowlist.
//
// Builds gvisor-tap-vsock DNS zones from an allow_net list.
// Allowed hostnames resolve normally; everything else gets 0.0.0.0.

import (
	"context"
	"net"
	"regexp"
	"strings"

	"github.com/containers/gvisor-tap-vsock/pkg/types"
	logrus "github.com/sirupsen/logrus"
)

// allowNetResolution bundles the DNS zones and the hostname→IP maps produced by
// one pass over the allow_net rules. Sharing that single resolution between the
// gateway DNS and the TCP egress pin guarantees the guest and the pin see the
// same IPs (same DNS, same moment) — see allow_net_filter.AllowHostToIP.
//
// The resolution is FROZEN at box build time: buildAllowNet runs once in
// gvproxy_create and is never re-resolved for the box's lifetime. A domain that
// changes its IP after the box starts therefore becomes unreachable until the
// box is recreated — a known, accepted limitation of hostname allow_net.
//
// Coupling contract: the egress pin (exactIPs/suffixIPs) must always be fed
// from the SAME resolution as the DNS zones. If a future change adds runtime
// re-resolution (e.g. to pick up IP changes), it must refresh the pin map from
// that same re-resolution too — otherwise AllowHostToIP keeps enforcing the
// stale IPs and would block the freshly-resolved destination.
type allowNetResolution struct {
	zones     []types.Zone
	exactIPs  map[string][]net.IP // "api.openai.com" → resolved IPv4 set
	suffixIPs map[string][]net.IP // ".example.com" → resolved base-domain IPv4 set
}

// buildAllowNet resolves every hostname rule once and returns the DNS zones
// plus the hostname→IP maps used to pin TCP egress.
func buildAllowNet(allowNet []string) allowNetResolution {
	return buildAllowNetWithResolver(allowNet, systemLookupIPAddr)
}

// buildAllowNetWithResolver is the testable core of buildAllowNet: the resolver
// is injected so tests can pin a deterministic resolution.
func buildAllowNetWithResolver(allowNet []string, lookup func(context.Context, string) ([]net.IP, error)) allowNetResolution {
	zoneRecords := make(map[string][]types.Record)
	exactIPs := make(map[string][]net.IP)
	suffixIPs := make(map[string][]net.IP)

	for _, rule := range allowNet {
		rule = strings.TrimSpace(rule)
		if rule == "" {
			continue
		}

		// Skip IP addresses and CIDRs (DNS filtering only handles hostnames)
		if net.ParseIP(rule) != nil {
			continue
		}
		if _, _, err := net.ParseCIDR(rule); err == nil {
			continue
		}

		// Strip port if present
		host := rule
		if h, _, err := net.SplitHostPort(rule); err == nil {
			host = h
		}

		// Wildcard: *.example.com — pinned to the base domain's resolution.
		if strings.HasPrefix(host, "*.") {
			domain := host[2:]
			zoneName := domain + "."
			zoneRecords[zoneName] = append(zoneRecords[zoneName], types.Record{
				Regexp: regexp.MustCompile(".*"),
			})
			suffixIPs["."+strings.ToLower(domain)] = resolveAndAddRecords(domain, zoneName, zoneRecords, lookup)
			continue
		}

		// Exact hostname: api.openai.com
		parts := strings.SplitN(host, ".", 2)
		if len(parts) == 2 {
			zoneName := parts[1] + "."
			exactIPs[strings.ToLower(host)] = resolveAndAddRecords(host, zoneName, zoneRecords, lookup)
		} else {
			exactIPs[strings.ToLower(host)] = resolveAndAddRecords(host, host+".", zoneRecords, lookup)
		}
	}

	var zones []types.Zone
	for zoneName, records := range zoneRecords {
		zones = append(zones, types.Zone{
			Name:      zoneName,
			Records:   records,
			DefaultIP: net.IPv4(0, 0, 0, 0), // Sinkhole non-allowed hosts in this TLD
		})
		logrus.WithFields(logrus.Fields{
			"zone":    zoneName,
			"records": len(records),
		}).Debug("allowNet: added DNS zone")
	}

	// Catch-all root zone: sinkhole everything not explicitly allowed
	zones = append(zones, types.Zone{
		Name:      "",
		DefaultIP: net.IPv4(0, 0, 0, 0),
	})

	logrus.WithFields(logrus.Fields{
		"allow_zones": len(zones) - 1,
		"total_zones": len(zones),
	}).Info("allowNet: DNS sinkhole configured")

	return allowNetResolution{zones: zones, exactIPs: exactIPs, suffixIPs: suffixIPs}
}

// buildAllowNetDNSZones creates DNS zones that implement allowlist filtering.
//
// Strategy:
//   - For each allowed hostname: resolve to IPs, create a zone with A records
//   - For wildcard patterns (*.example.com): create zone with Regexp records
//   - Add catch-all root zone "" with DefaultIP 0.0.0.0 (sinkhole)
//
// Zone matching is first-match-wins with suffix matching. Specific zones
// are added before the root zone, so allowed hosts resolve normally while
// everything else gets sinkholed.
func buildAllowNetDNSZones(allowNet []string) []types.Zone {
	return buildAllowNet(allowNet).zones
}

// systemLookupIPAddr resolves a hostname via the host's system DNS. It is the
// production resolver behind the buildAllowNet seam.
func systemLookupIPAddr(ctx context.Context, host string) ([]net.IP, error) {
	resolver := &net.Resolver{PreferGo: false}
	addrs, err := resolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	ips := make([]net.IP, 0, len(addrs))
	for _, a := range addrs {
		ips = append(ips, a.IP)
	}
	return ips, nil
}

// resolveAndAddRecords resolves a hostname, adds A records to the zone, and
// returns the resolved IPv4 set so callers can pin egress to the same IPs.
func resolveAndAddRecords(hostname, zoneName string, zoneRecords map[string][]types.Record, lookup func(context.Context, string) ([]net.IP, error)) []net.IP {
	ctx := context.Background()
	ips, err := lookup(ctx, hostname)
	if err != nil {
		logrus.WithFields(logrus.Fields{
			"hostname": hostname,
			"error":    err,
		}).Warn("allowNet: DNS resolution failed for allowed host")
		return nil
	}

	trimmed := strings.TrimSuffix(hostname+".", "."+zoneName)

	var v4 []net.IP
	for _, ip := range ips {
		if ip.To4() == nil {
			continue // Skip IPv6 for now
		}
		ip4 := ip.To4()
		v4 = append(v4, ip4)
		zoneRecords[zoneName] = append(zoneRecords[zoneName], types.Record{
			Name: trimmed,
			IP:   ip4,
		})
		logrus.WithFields(logrus.Fields{
			"hostname": hostname,
			"ip":       ip,
			"zone":     zoneName,
			"label":    trimmed,
		}).Debug("allowNet: resolved and added DNS record")
	}
	return v4
}
