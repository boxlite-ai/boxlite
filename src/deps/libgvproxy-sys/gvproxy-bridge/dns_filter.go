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
//
// `ctx` is honored throughout the resolution loop: cancellation aborts
// the current attempt and the inter-attempt backoff sleep, so a Ctrl-C
// or process shutdown ends `box.create` promptly instead of waiting for
// the full retry budget to drain.
func buildAllowNetDNSZones(ctx context.Context, allowNet []string) ([]types.Zone, error) {
	return buildAllowNetDNSZonesWith(ctx, allowNet, defaultResolver)
}

// buildAllowNetDNSZonesWith is the testable form: same behavior as
// buildAllowNetDNSZones, with an injectable resolver.
func buildAllowNetDNSZonesWith(ctx context.Context, allowNet []string, resolver hostResolver) ([]types.Zone, error) {
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
			if err := resolveAndAddRecords(ctx, resolver, domain, domain+".", zoneRecords); err != nil {
				return nil, err
			}
			continue
		}

		// Exact hostname: api.openai.com
		parts := strings.SplitN(host, ".", 2)
		if len(parts) == 2 {
			zoneName := parts[1] + "."
			if err := resolveAndAddRecords(ctx, resolver, host, zoneName, zoneRecords); err != nil {
				return nil, err
			}
		} else {
			if err := resolveAndAddRecords(ctx, resolver, host, host+".", zoneRecords); err != nil {
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
// every attempt fails so callers can fail closed. Honors `ctx` so a
// caller cancellation propagates through both the in-flight lookup and
// the inter-attempt backoff.
func resolveAndAddRecords(ctx context.Context, resolver hostResolver, hostname, zoneName string, zoneRecords map[string][]types.Record) error {
	ips, err := lookupWithRetry(ctx, resolver, hostname)
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
//
// `parentCtx` is the caller's lifetime context (typically a process-
// level signal-aware ctx from `gvproxy_create`). Each attempt's deadline
// is derived from it, so a cancellation (Ctrl-C, shutdown) terminates
// both the in-flight lookup *and* the inter-attempt backoff sleep —
// without this, a hung resolver could keep `box.create` blocked for the
// full retry budget even after the user has asked for it to stop.
func lookupWithRetry(parentCtx context.Context, resolver hostResolver, hostname string) ([]net.IPAddr, error) {
	var (
		ips     []net.IPAddr
		lastErr error
	)
	backoff := dnsLookupInitialBackoffVar

	for attempt := 1; attempt <= dnsLookupAttempts; attempt++ {
		// Bail before spending another attempt if the caller already cancelled.
		if err := parentCtx.Err(); err != nil {
			return nil, err
		}

		ctx, cancel := context.WithTimeout(parentCtx, dnsLookupAttemptTimeoutVar)
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

		// If the parent ctx was cancelled mid-attempt, surface that as the
		// terminal error rather than retrying — the caller has gone away.
		if parentCtx.Err() != nil {
			if lastErr != nil {
				return nil, lastErr
			}
			return nil, parentCtx.Err()
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

			// Interruptible backoff: react to Ctrl-C / shutdown immediately
			// instead of sleeping out the (potentially multi-second) delay.
			timer := time.NewTimer(backoff)
			select {
			case <-parentCtx.Done():
				timer.Stop()
				return nil, parentCtx.Err()
			case <-timer.C:
			}
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
