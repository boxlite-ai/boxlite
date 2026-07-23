package main

// dns_filter.go — DNS sinkhole for network allowlist.
//
// Builds gvisor-tap-vsock DNS zones from an allow_net list.
// Allowed hostnames resolve normally; everything else gets 0.0.0.0.

import (
	"context"
	"fmt"
	"net"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/containers/gvisor-tap-vsock/pkg/types"
	logrus "github.com/sirupsen/logrus"
)

// Tunables for allowlist DNS resolution. Each allow-listed hostname is
// resolved against the host OS resolver at box-create time and the
// resulting IPs are baked into the DNS sinkhole. A transient host-side
// DNS hiccup (VPN flap, slow corp resolver, mDNSResponder churn) used to
// silently drop the host's zone, leaving the VM permanently sinkholing
// it to 0.0.0.0 for the life of the box. We now retry with backoff and
// fail closed if every attempt fails.
//
// Exposed as `var` (not `const`) so tests can override timing without
// slowing the suite. Production callers MUST treat them as immutable.
const dnsLookupAttempts = 4

var (
	dnsLookupInitialBackoffVar = 100 * time.Millisecond
	dnsLookupBackoffFactor     = 3
	dnsLookupAttemptTimeoutVar = 2 * time.Second
)

// hostResolver is the interface buildAllowNetDNSZones uses to look up
// allow-listed hostnames. The production implementation calls the host
// OS resolver via net.Resolver. Tests inject a fake to exercise the
// retry/backoff/fail-closed paths without depending on real DNS.
type hostResolver interface {
	LookupIPAddr(ctx context.Context, host string) ([]net.IPAddr, error)
}

// defaultResolver is the production resolver: PreferGo:false uses the
// platform's getaddrinfo, which honors VPN/corp DNS configuration.
var defaultResolver hostResolver = &net.Resolver{PreferGo: false}

// buildAllowNetDNSZones creates DNS zones that implement allowlist filtering.
//
// Strategy:
//   - For each allowed hostname: resolve to IPs (with retry/backoff), create
//     a zone with A records.
//   - For wildcard patterns (*.example.com): create zone with Regexp records.
//   - Add catch-all root zone "" with DefaultIP 0.0.0.0 (sinkhole).
//
// Zone matching is first-match-wins with suffix matching. Specific zones
// are added before the root zone, so allowed hosts resolve normally while
// everything else gets sinkholed.
//
// Fail-closed: if any allow-listed hostname cannot be resolved after all
// retry attempts, this function returns an error instead of producing a
// silently-incomplete sinkhole. The caller is expected to abort box
// creation rather than ship a misconfigured network.
func buildAllowNetDNSZones(allowNet []string) ([]types.Zone, error) {
	return buildAllowNetDNSZonesWith(allowNet, defaultResolver)
}

// buildAllowNetDNSZonesWith is the testable form: same behavior as
// buildAllowNetDNSZones, with an injectable resolver.
func buildAllowNetDNSZonesWith(allowNet []string, resolver hostResolver) ([]types.Zone, error) {
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
			if err := resolveAndAddRecords(resolver, domain, domain+".", zoneRecords); err != nil {
				return nil, err
			}
			continue
		}

		// Exact hostname: api.openai.com
		parts := strings.SplitN(host, ".", 2)
		if len(parts) == 2 {
			zoneName := parts[1] + "."
			if err := resolveAndAddRecords(resolver, host, zoneName, zoneRecords); err != nil {
				return nil, err
			}
		} else {
			if err := resolveAndAddRecords(resolver, host, host+".", zoneRecords); err != nil {
				return nil, err
			}
		}
	}

	// Build the zone slice in deterministic, longest-name-first order.
	//
	// gvisor-tap-vsock's DNS handler is *first-match-wins on suffix*, with no
	// most-specific-match preference. If we left `zoneRecords` in map-iteration
	// order, an `iapi.merck.com` query could land on the `com.` zone (created
	// because we allow-listed `github.com`) before the `merck.com.` zone, fall
	// through to that zone's DefaultIP=0.0.0.0, and return a sinkhole answer —
	// even though we *do* have a real record for it under a more specific zone.
	//
	// Sorting longest-name-first guarantees the most-specific suffix wins,
	// which matches both standard DNS semantics and the behavior callers
	// expect from an allow-list ("the host I named must resolve").
	zoneNames := make([]string, 0, len(zoneRecords))
	for zoneName := range zoneRecords {
		zoneNames = append(zoneNames, zoneName)
	}
	sort.Slice(zoneNames, func(i, j int) bool {
		return len(zoneNames[i]) > len(zoneNames[j])
	})

	var zones []types.Zone
	for _, zoneName := range zoneNames {
		records := zoneRecords[zoneName]
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

	return zones, nil
}

// resolveAndAddRecords resolves a hostname (with retry + per-attempt
// timeout) and adds A records to the zone. Returns the final error if
// every attempt fails so callers can fail closed.
func resolveAndAddRecords(resolver hostResolver, hostname, zoneName string, zoneRecords map[string][]types.Record) error {
	ips, err := lookupWithRetry(resolver, hostname)
	if err != nil {
		return fmt.Errorf("allowNet: resolve %q: %w", hostname, err)
	}

	trimmed := strings.TrimSuffix(hostname+".", "."+zoneName)

	v4Count := 0
	v4Strs := make([]string, 0, len(ips))
	for _, ip := range ips {
		if ip.IP.To4() == nil {
			continue // Skip IPv6 for now
		}
		v4Count++
		v4Strs = append(v4Strs, ip.IP.String())
		zoneRecords[zoneName] = append(zoneRecords[zoneName], types.Record{
			Name: trimmed,
			IP:   ip.IP.To4(),
		})
	}

	// One Info line per allow-listed host. Without this it's invisible
	// whether a hostname's lookup succeeded but yielded only IPv6 (which
	// we drop), which would silently sinkhole that host even though no
	// retry/error fired. v4_count=0 is the smoking gun for that case.
	logrus.WithFields(logrus.Fields{
		"hostname": hostname,
		"zone":     zoneName,
		"label":    trimmed,
		"v4_count": v4Count,
		"v4_ips":   v4Strs,
	}).Info("allowNet: host resolved")

	return nil
}

// lookupWithRetry calls resolver.LookupIPAddr up to dnsLookupAttempts
// times, with a per-attempt context timeout and exponential backoff
// between attempts. Each attempt that returns at least one IP wins
// immediately. Each attempt that returns an empty list with no error is
// treated as a failure so we retry rather than bake an empty zone.
func lookupWithRetry(resolver hostResolver, hostname string) ([]net.IPAddr, error) {
	var (
		ips     []net.IPAddr
		lastErr error
	)
	backoff := dnsLookupInitialBackoffVar

	for attempt := 1; attempt <= dnsLookupAttempts; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), dnsLookupAttemptTimeoutVar)
		ips, lastErr = resolver.LookupIPAddr(ctx, hostname)
		cancel()

		if lastErr == nil && len(ips) > 0 {
			if attempt > 1 {
				logrus.WithFields(logrus.Fields{
					"hostname": hostname,
					"attempts": attempt,
				}).Info("allowNet: DNS resolution succeeded after retry")
			}
			return ips, nil
		}

		if lastErr == nil {
			lastErr = fmt.Errorf("no A records returned")
		}

		if attempt < dnsLookupAttempts {
			logrus.WithFields(logrus.Fields{
				"hostname":   hostname,
				"attempt":    attempt,
				"error":      lastErr,
				"next_delay": backoff,
			}).Warn("allowNet: DNS resolution failed, will retry")
			time.Sleep(backoff)
			backoff *= time.Duration(dnsLookupBackoffFactor)
		}
	}

	logrus.WithFields(logrus.Fields{
		"hostname": hostname,
		"attempts": dnsLookupAttempts,
		"error":    lastErr,
	}).Error("allowNet: DNS resolution failed after retries")
	return nil, lastErr
}
