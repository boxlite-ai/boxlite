package main

// dns_filter.go — DNS sinkhole for network allowlist.
//
// Builds gvisor-tap-vsock DNS zones from an allow_net list.
// Allowed hostnames resolve normally; everything else gets 0.0.0.0.

import (
	"context"
	"net"
	"regexp"
	"sort"
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
	// One resolution per canonical hostname. Two rules naming the same host
	// ("x.com:443" beside "x.com", say) would otherwise be looked up twice: both answers become zone records,
	// the resolver serves the first, and the pin map keeps only the last — so a
	// round-robin host resolves to an address AllowHostToIP rejects. That is
	// the coupling contract this type documents.
	resolved := make(map[string]bool)

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
			if resolved["*."+domain] {
				continue
			}
			resolved["*."+domain] = true
			zoneName := domain + "."
			ips := resolveAndAddRecords(domain, zoneName, zoneRecords, lookup)
			suffix := "." + strings.ToLower(domain)
			// Union, not overwrite: a second spelling of this domain resolves
			// separately, and DNS may serve either answer, so the pin has to
			// permit both or AllowHostToIP blocks the address it served.
			suffixIPs[suffix] = append(suffixIPs[suffix], ips...)
			// The catch-all answers with the base domain's own addresses, the
			// same set AllowHostToIP pins this wildcard to. Adding it without an
			// IP (as this did) matched every subdomain and answered with none,
			// so a wildcard rule resolved to nothing at all.
			for _, ip := range ips {
				zoneRecords[zoneName] = append(zoneRecords[zoneName], types.Record{
					Regexp: regexp.MustCompile(".*"),
					IP:     ip,
				})
			}
			continue
		}

		// Exact hostname: api.openai.com
		if resolved[host] {
			continue
		}
		resolved[host] = true
		parts := strings.SplitN(host, ".", 2)
		if len(parts) == 2 {
			zoneName := parts[1] + "."
			key := strings.ToLower(host)
			exactIPs[key] = append(exactIPs[key], resolveAndAddRecords(host, zoneName, zoneRecords, lookup)...)
		} else {
			key := strings.ToLower(host)
			exactIPs[key] = append(exactIPs[key], resolveAndAddRecords(host, host+".", zoneRecords, lookup)...)
		}
	}

	// Coverage a zone inherits from a wider wildcard. An exact rule creates a
	// zone at its parent's depth ("api.team.x.test" -> zone "team.x.test."),
	// and the resolver answers from the first matching zone alone — so that new
	// zone would sinkhole "other.team.x.test" even while "*.x.test" allows it.
	// The egress filter already treats those siblings as allowed
	// (MatchesHostname suffix-matches at any depth); this keeps DNS from
	// disagreeing with it.
	wildcardSuffixes := make([]string, 0, len(suffixIPs))
	for suffix := range suffixIPs {
		wildcardSuffixes = append(wildcardSuffixes, suffix)
	}
	sort.Slice(wildcardSuffixes, func(i, j int) bool {
		if len(wildcardSuffixes[i]) != len(wildcardSuffixes[j]) {
			return len(wildcardSuffixes[i]) > len(wildcardSuffixes[j])
		}
		return wildcardSuffixes[i] < wildcardSuffixes[j]
	})
	for zoneName, records := range zoneRecords {
		if hasCatchAll(records) {
			continue
		}
		name := strings.ToLower(strings.TrimSuffix(zoneName, "."))
		// Most specific covering wildcard wins, and only it contributes:
		// suffixIPs is a map, so taking every match in range order would let
		// the answer for an existing host change from one run to the next.
		for _, suffix := range wildcardSuffixes {
			if !strings.HasSuffix(name, suffix) {
				continue
			}
			// A wildcard whose own lookup failed has no address to inherit;
			// fall through to a broader one that resolved rather than leaving
			// the zone with a bare sinkhole.
			ips := suffixIPs[suffix]
			if len(ips) == 0 {
				continue
			}
			for _, ip := range ips {
				records = append(records, types.Record{
					Regexp: regexp.MustCompile(".*"),
					IP:     ip,
				})
			}
			break
		}
		zoneRecords[zoneName] = records
	}

	// Exact records before the catch-all, within every zone. The resolver
	// returns the first matching record, and a wildcard's `.*` matches any
	// subdomain — including one an exact rule also names, whose own resolution
	// is what the egress pin holds. Rule order in allow_net must not decide
	// which of the two answers.
	for zoneName, records := range zoneRecords {
		sort.SliceStable(records, func(i, j int) bool {
			return records[i].Regexp == nil && records[j].Regexp != nil
		})
		zoneRecords[zoneName] = records
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

	// Most specific zone first. The resolver takes the FIRST zone whose suffix
	// matches and answers from that zone alone — with its sinkhole DefaultIP
	// when no record inside it matches (gvisor-tap-vsock dns.go). So when one
	// zone name is a suffix of another ("com." and "example.com.", which the
	// rules "example.com" and "api.example.com" produce), visiting the shorter
	// one first sinkholes a host the longer one explicitly allows. zoneRecords
	// is a map, so without this the order — and the outcome — is random.
	// A longer name is never less specific, so descending length is enough;
	// the name tiebreak only keeps the result stable.
	sort.Slice(zones, func(i, j int) bool {
		if len(zones[i].Name) != len(zones[j].Name) {
			return len(zones[i].Name) > len(zones[j].Name)
		}
		return zones[i].Name < zones[j].Name
	})

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

// hasCatchAll reports whether a zone already answers for names no exact record
// in it names.
func hasCatchAll(records []types.Record) bool {
	for _, record := range records {
		if record.Regexp != nil {
			return true
		}
	}
	return false
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
