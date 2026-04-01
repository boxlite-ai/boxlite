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
	zoneRecords := make(map[string][]types.Record)

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

		// Wildcard: *.example.com
		if strings.HasPrefix(host, "*.") {
			domain := host[2:]
			zoneName := domain + "."
			zoneRecords[zoneName] = append(zoneRecords[zoneName], types.Record{
				Regexp: regexp.MustCompile(".*"),
			})
			resolveAndAddRecords(domain, domain+".", zoneRecords)
			continue
		}

		// Exact hostname: api.openai.com
		parts := strings.SplitN(host, ".", 2)
		if len(parts) == 2 {
			zoneName := parts[1] + "."
			resolveAndAddRecords(host, zoneName, zoneRecords)
		} else {
			resolveAndAddRecords(host, host+".", zoneRecords)
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

	return zones
}

// resolveAndAddRecords resolves a hostname and adds A records to the zone.
func resolveAndAddRecords(hostname, zoneName string, zoneRecords map[string][]types.Record) {
	ctx := context.Background()
	resolver := &net.Resolver{PreferGo: false}
	ips, err := resolver.LookupIPAddr(ctx, hostname)
	if err != nil {
		logrus.WithFields(logrus.Fields{
			"hostname": hostname,
			"error":    err,
		}).Warn("allowNet: DNS resolution failed for allowed host")
		return
	}

	trimmed := strings.TrimSuffix(hostname+".", "."+zoneName)

	for _, ip := range ips {
		if ip.IP.To4() == nil {
			continue // Skip IPv6 for now
		}
		zoneRecords[zoneName] = append(zoneRecords[zoneName], types.Record{
			Name: trimmed,
			IP:   ip.IP.To4(),
		})
		logrus.WithFields(logrus.Fields{
			"hostname": hostname,
			"ip":       ip.IP,
			"zone":     zoneName,
			"label":    trimmed,
		}).Debug("allowNet: resolved and added DNS record")
	}
}
