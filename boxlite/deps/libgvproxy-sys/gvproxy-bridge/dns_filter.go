package main

import (
	"context"
	"net"
	"regexp"
	"strings"
	"sync"

	"github.com/containers/gvisor-tap-vsock/pkg/types"
	logrus "github.com/sirupsen/logrus"
)

// AllowNetMatcher checks hostnames and IPs against an allowlist.
type AllowNetMatcher struct {
	// Exact hostnames (lowercase)
	exactHosts map[string]bool
	// Wildcard suffixes (e.g., ".example.com" for "*.example.com")
	wildcardSuffixes []string
	// Exact IPs
	exactIPs map[string]bool
	// CIDR ranges
	cidrRanges []*net.IPNet
	// Port-specific rules: "host:port"
	portRules map[string]bool

	// Dynamic IP allowlist populated by DNS resolution
	dynamicIPs   map[string]bool
	dynamicIPsMu sync.RWMutex
}

// NewAllowNetMatcher parses allowNet rules into a matcher.
func NewAllowNetMatcher(rules []string) *AllowNetMatcher {
	m := &AllowNetMatcher{
		exactHosts: make(map[string]bool),
		exactIPs:   make(map[string]bool),
		portRules:  make(map[string]bool),
		dynamicIPs: make(map[string]bool),
	}

	for _, rule := range rules {
		rule = strings.TrimSpace(rule)
		if rule == "" {
			continue
		}

		// Check for CIDR notation
		if _, cidr, err := net.ParseCIDR(rule); err == nil {
			m.cidrRanges = append(m.cidrRanges, cidr)
			continue
		}

		// Check for IP address (without port)
		if ip := net.ParseIP(rule); ip != nil {
			m.exactIPs[ip.String()] = true
			continue
		}

		// Check for wildcard: *.example.com
		if strings.HasPrefix(rule, "*.") {
			suffix := strings.ToLower(rule[1:]) // ".example.com"
			m.wildcardSuffixes = append(m.wildcardSuffixes, suffix)
			continue
		}

		// Check for host:port
		if host, port, err := net.SplitHostPort(rule); err == nil {
			m.portRules[strings.ToLower(host)+":"+port] = true
			// Also add the host to exact hosts for DNS resolution
			m.exactHosts[strings.ToLower(host)] = true
			continue
		}

		// Default: exact hostname
		m.exactHosts[strings.ToLower(rule)] = true
	}

	return m
}

// MatchesHost checks if a hostname is allowed.
func (m *AllowNetMatcher) MatchesHost(hostname string) bool {
	hostname = strings.TrimSuffix(strings.ToLower(hostname), ".")

	// Exact match
	if m.exactHosts[hostname] {
		return true
	}

	// Wildcard suffix match
	for _, suffix := range m.wildcardSuffixes {
		if strings.HasSuffix(hostname, suffix) {
			return true
		}
	}

	// Check if hostname is an IP
	if ip := net.ParseIP(hostname); ip != nil {
		return m.MatchesIP(ip, 0)
	}

	return false
}

// MatchesIP checks if an IP (and optionally port) is allowed.
func (m *AllowNetMatcher) MatchesIP(ip net.IP, port uint16) bool {
	ipStr := ip.String()

	// Exact IP match
	if m.exactIPs[ipStr] {
		return true
	}

	// Dynamic IP (resolved from allowed hostname)
	m.dynamicIPsMu.RLock()
	if m.dynamicIPs[ipStr] {
		m.dynamicIPsMu.RUnlock()
		return true
	}
	m.dynamicIPsMu.RUnlock()

	// CIDR match
	for _, cidr := range m.cidrRanges {
		if cidr.Contains(ip) {
			return true
		}
	}

	return false
}

// AddDynamicIP adds a resolved IP to the dynamic allowlist.
// Called by the DNS filter when resolving an allowed hostname.
func (m *AllowNetMatcher) AddDynamicIP(ip string) {
	m.dynamicIPsMu.Lock()
	m.dynamicIPs[ip] = true
	m.dynamicIPsMu.Unlock()
}

// ResolveDNS resolves a hostname and returns IPs if the hostname is allowed.
// If allowed, the resolved IPs are added to the dynamic allowlist.
// If not allowed, returns nil.
func (m *AllowNetMatcher) ResolveDNS(hostname string) []net.IP {
	if !m.MatchesHost(hostname) {
		logrus.WithField("hostname", hostname).Debug("dns_filter: blocked")
		return nil
	}

	// Resolve via host DNS
	ctx := context.Background()
	resolver := &net.Resolver{PreferGo: false}
	ips, err := resolver.LookupIPAddr(ctx, hostname)
	if err != nil {
		logrus.WithFields(logrus.Fields{
			"hostname": hostname,
			"error":    err,
		}).Debug("dns_filter: resolve failed")
		return nil
	}

	var result []net.IP
	for _, ip := range ips {
		result = append(result, ip.IP)
		m.AddDynamicIP(ip.IP.String())
	}

	logrus.WithFields(logrus.Fields{
		"hostname": hostname,
		"ips":      result,
	}).Debug("dns_filter: allowed")

	return result
}

// buildAllowNetDNSZones creates DNS zones that implement allowlist filtering.
//
// Strategy:
//   - For each allowed hostname: resolve to IPs, create a zone with A records
//   - For wildcard patterns (*.example.com): create zone with Regexp records
//   - Add catch-all root zone "" with DefaultIP 0.0.0.0 (sinkhole for blocked queries)
//
// Zone matching is first-match-wins with suffix matching. Specific zones
// are added before the root zone, so allowed hosts resolve normally while
// everything else gets sinkholed.
func buildAllowNetDNSZones(allowNet []string) []types.Zone {
	// Map: zone domain → records within that zone
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

		// Strip port if present (DNS doesn't handle ports)
		host := rule
		if h, _, err := net.SplitHostPort(rule); err == nil {
			host = h
		}

		// Handle wildcard: *.example.com
		if strings.HasPrefix(host, "*.") {
			domain := host[2:] // "example.com"
			zoneName := domain + "."
			// Regexp record matches any subdomain
			zoneRecords[zoneName] = append(zoneRecords[zoneName], types.Record{
				Regexp: regexp.MustCompile(".*"),
			})

			// Also resolve the base domain itself
			resolveAndAddRecords(domain, domain+".", zoneRecords)
			continue
		}

		// Exact hostname: api.openai.com
		// Zone = parent domain, Record = subdomain label
		parts := strings.SplitN(host, ".", 2)
		if len(parts) == 2 {
			subdomain := parts[0]        // "api"
			parentDomain := parts[1]     // "openai.com"
			zoneName := parentDomain + "." // "openai.com."

			// Resolve hostname to IPs and create records
			resolveAndAddRecords(host, zoneName, zoneRecords)

			// If no IPs resolved, still add a record so it matches (will get DefaultIP)
			if len(zoneRecords[zoneName]) == 0 {
				logrus.WithField("host", host).Warn("allowNet: could not resolve hostname, adding name-only record")
				zoneRecords[zoneName] = append(zoneRecords[zoneName], types.Record{
					Name: subdomain,
				})
			}
		} else {
			// Single-label hostname (rare), resolve directly
			resolveAndAddRecords(host, host+".", zoneRecords)
		}
	}

	// Build zone list (specific zones first)
	var zones []types.Zone
	for zoneName, records := range zoneRecords {
		zones = append(zones, types.Zone{
			Name:    zoneName,
			Records: records,
		})
		logrus.WithFields(logrus.Fields{
			"zone":    zoneName,
			"records": len(records),
		}).Debug("allowNet: added DNS zone")
	}

	// Add catch-all root zone (empty name = matches everything)
	// DefaultIP 0.0.0.0 sinkholes all non-allowed queries
	zones = append(zones, types.Zone{
		Name:      "",
		DefaultIP: net.IPv4(0, 0, 0, 0),
	})

	logrus.WithFields(logrus.Fields{
		"allow_zones": len(zones) - 1,
		"total_zones": len(zones),
	}).Info("allowNet: DNS filtering configured")

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

	// Determine the subdomain label (part before the zone suffix)
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
