package main

import (
	"context"
	"fmt"
	"net"
	"testing"
	"time"

	"github.com/containers/gvisor-tap-vsock/pkg/services/dns"
	"github.com/containers/gvisor-tap-vsock/pkg/types"
	mdns "github.com/miekg/dns"
)

func TestBuildAllowNetDNSZones(t *testing.T) {
	zones := buildAllowNetDNSZones([]string{
		"api.openai.com",
		"*.anthropic.com",
		"192.168.1.1", // IP — skipped (DNS only handles hostnames)
	})

	if len(zones) < 2 {
		t.Errorf("expected at least 2 zones, got %d", len(zones))
	}

	// Last zone should be the catch-all root zone
	lastZone := zones[len(zones)-1]
	if lastZone.Name != "" {
		t.Errorf("last zone should be root (empty name), got %q", lastZone.Name)
	}
	if !lastZone.DefaultIP.Equal(net.IPv4(0, 0, 0, 0)) {
		t.Errorf("root zone should have DefaultIP 0.0.0.0, got %v", lastZone.DefaultIP)
	}
}

func TestBuildAllowNetDNSZones_PerTLDZonesHaveSinkholeDefaultIP(t *testing.T) {
	zones := buildAllowNetDNSZones([]string{"example.com"})

	// Should have 2 zones: "com." (per-TLD) + "" (root catch-all)
	if len(zones) != 2 {
		t.Fatalf("expected 2 zones, got %d", len(zones))
	}

	// Per-TLD zone must have DefaultIP 0.0.0.0 so non-allowed hosts
	// in the same TLD get sinkholed (not NXDOMAIN which triggers DNS fallback)
	for _, zone := range zones {
		if !zone.DefaultIP.Equal(net.IPv4(0, 0, 0, 0)) {
			t.Errorf("zone %q should have DefaultIP 0.0.0.0, got %v", zone.Name, zone.DefaultIP)
		}
	}
}

func TestBuildAllowNetDNSZones_EmptyList(t *testing.T) {
	zones := buildAllowNetDNSZones([]string{})

	if len(zones) != 1 {
		t.Errorf("expected 1 zone (root only), got %d", len(zones))
	}
	if zones[0].Name != "" {
		t.Errorf("single zone should be root, got %q", zones[0].Name)
	}
}

// TestBuildAllowNet_FrozenBuildTimeResolution pins the frozen-resolution
// contract: buildAllowNet resolves each hostname once at build time and bakes
// the result into BOTH the DNS zones and the egress pin map. A domain that
// changes its IP afterwards is not picked up by the running box — a fresh build
// (a new box) is required. If re-resolution is ever added, this test and the
// pin must be updated together (see allowNetResolution's coupling contract).
func TestBuildAllowNet_FrozenBuildTimeResolution(t *testing.T) {
	lookup := func(_ context.Context, _ string) ([]net.IP, error) {
		return []net.IP{net.ParseIP("10.0.0.1").To4()}, nil
	}

	res := buildAllowNetWithResolver([]string{"api.example.com"}, lookup)

	// The single resolution is baked into the pin map...
	if got := res.exactIPs["api.example.com"]; len(got) != 1 || !got[0].Equal(net.ParseIP("10.0.0.1")) {
		t.Fatalf("pin map should hold the resolved IP, got %v", got)
	}
	// ...and into the DNS zone A record (same source, same IP).
	if len(res.zones) != 2 {
		t.Fatalf("expected 2 zones (per-TLD + root), got %d", len(res.zones))
	}
	zone := res.zones[0]
	if zone.Name != "example.com." || len(zone.Records) != 1 || !zone.Records[0].IP.Equal(net.ParseIP("10.0.0.1")) {
		t.Fatalf("DNS zone should bake the same IP as the pin, got zone=%q records=%v", zone.Name, zone.Records)
	}

	// Simulate the domain switching IP after the box is built.
	lookup = func(_ context.Context, _ string) ([]net.IP, error) {
		return []net.IP{net.ParseIP("10.0.0.2").To4()}, nil
	}

	// The already-built resolution is frozen — it still serves the old IP.
	if got := res.exactIPs["api.example.com"]; len(got) != 1 || !got[0].Equal(net.ParseIP("10.0.0.1")) {
		t.Fatalf("built resolution must stay frozen after the domain changes IP, got %v", got)
	}

	// Only a fresh build (a recreated box) picks up the new IP.
	fresh := buildAllowNetWithResolver([]string{"api.example.com"}, lookup)
	if got := fresh.exactIPs["api.example.com"]; len(got) != 1 || !got[0].Equal(net.ParseIP("10.0.0.2")) {
		t.Fatalf("a fresh build should resolve the new IP, got %v", got)
	}
}

// TestBuildAllowNet_PinCoversSameHostsAsDNS asserts the pin map is keyed by
// exactly the hostname rules the gateway DNS serves, so the pin can never
// diverge from the DNS zones. IP/CIDR rules produce no hostname pin keys.
func TestBuildAllowNet_PinCoversSameHostsAsDNS(t *testing.T) {
	lookup := func(_ context.Context, _ string) ([]net.IP, error) {
		return []net.IP{net.ParseIP("10.0.0.1").To4()}, nil
	}

	res := buildAllowNetWithResolver([]string{"api.openai.com", "*.anthropic.com", "1.2.3.4", "10.0.0.0/8"}, lookup)

	if _, ok := res.exactIPs["api.openai.com"]; !ok {
		t.Errorf("expected exact pin key for api.openai.com")
	}
	if _, ok := res.suffixIPs[".anthropic.com"]; !ok {
		t.Errorf("expected wildcard suffix pin key for .anthropic.com")
	}
	if len(res.exactIPs) != 1 || len(res.suffixIPs) != 1 {
		t.Errorf("IP/CIDR rules must not produce hostname pin keys, got exact=%v suffix=%v", res.exactIPs, res.suffixIPs)
	}
}

// TestBuildAllowNet_OverlappingZonesResolveTheMoreSpecificRule pins the zone
// ordering contract through the real resolver.
//
// "example.com" builds zone "com." and "api.example.com" builds zone
// "example.com.", so both zones suffix-match a query for api.example.com. The
// resolver answers from the first match alone, falling back to that zone's
// sinkhole when no record inside it matches — so if "com." is consulted first,
// an explicitly allowed host resolves to 0.0.0.0.
//
// Asserting ordering directly would only restate the sort; this serves the
// zones and queries them, so the answer comes from production code.
func TestBuildAllowNet_OverlappingZonesResolveTheMoreSpecificRule(t *testing.T) {
	lookup := func(_ context.Context, host string) ([]net.IP, error) {
		switch host {
		case "example.com":
			return []net.IP{net.IPv4(203, 0, 113, 10)}, nil
		case "api.example.com":
			return []net.IP{net.IPv4(203, 0, 113, 11)}, nil
		}
		return nil, fmt.Errorf("unexpected lookup for %q", host)
	}

	// Rebuild repeatedly: zoneRecords is a map, so a single pass could pass by
	// luck on the pre-sort code.
	for i := 0; i < 20; i++ {
		res := buildAllowNetWithResolver([]string{"example.com", "api.example.com"}, lookup)
		addr := serveZones(t, res.zones)

		if got := queryA(t, addr, "api.example.com"); got != "203.0.113.11" {
			t.Fatalf("iteration %d: api.example.com resolved to %q, want 203.0.113.11 "+
				"(a less specific zone swallowed the query)", i, got)
		}
		if got := queryA(t, addr, "example.com"); got != "203.0.113.10" {
			t.Fatalf("iteration %d: example.com resolved to %q, want 203.0.113.10", i, got)
		}
		// Nothing else under the allowed zones leaks through.
		if got := queryA(t, addr, "other.example.com"); got != "0.0.0.0" {
			t.Fatalf("iteration %d: other.example.com resolved to %q, want the sinkhole", i, got)
		}
	}
}

// serveZones runs the production DNS service over the given zones on a local
// UDP socket and returns its address.
func serveZones(t *testing.T, zones []types.Zone) string {
	t.Helper()
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	srv, err := dns.New(pc, nil, zones)
	if err != nil {
		t.Fatalf("dns.New: %v", err)
	}
	go func() { _ = srv.Serve() }()
	return pc.LocalAddr().String()
}

// queryA asks for one A record and returns it, or "" when there is no answer.
func queryA(t *testing.T, addr, name string) string {
	t.Helper()
	c := &mdns.Client{Timeout: 3 * time.Second}
	m := new(mdns.Msg)
	m.SetQuestion(mdns.Fqdn(name), mdns.TypeA)
	resp, _, err := c.Exchange(m, addr)
	if err != nil {
		t.Fatalf("dns exchange %s: %v", name, err)
	}
	for _, rr := range resp.Answer {
		if a, ok := rr.(*mdns.A); ok {
			return a.A.To4().String()
		}
	}
	return ""
}

// TestBuildAllowNet_WildcardAndExactRulesShareAZone pins record precedence
// inside one zone.
//
// "*.example.com" installs a catch-all for the zone and "api.example.com"
// installs an exact record in the same zone. The resolver returns the first
// matching record, so the catch-all must come last: the exact rule's own
// resolution is what the egress pin holds for that host, and rule order in
// allow_net must not decide the answer. The catch-all itself has to carry the
// base domain's addresses — the set AllowHostToIP pins the wildcard to —
// otherwise a wildcard rule answers with no address at all.
func TestBuildAllowNet_WildcardAndExactRulesShareAZone(t *testing.T) {
	const (
		baseIP  = "203.0.113.30"
		exactIP = "203.0.113.31"
	)
	lookup := func(_ context.Context, host string) ([]net.IP, error) {
		switch host {
		case "example.com":
			return []net.IP{net.ParseIP(baseIP)}, nil
		case "api.example.com":
			return []net.IP{net.ParseIP(exactIP)}, nil
		}
		return nil, fmt.Errorf("unexpected lookup for %q", host)
	}

	// Both rule orders: the outcome must not depend on which came first.
	for _, rules := range [][]string{
		{"*.example.com", "api.example.com"},
		{"api.example.com", "*.example.com"},
	} {
		res := buildAllowNetWithResolver(rules, lookup)
		addr := serveZones(t, res.zones)

		if got := queryA(t, addr, "api.example.com"); got != exactIP {
			t.Errorf("rules=%v: api.example.com resolved to %q, want its own %s", rules, got, exactIP)
		}
		// Any other subdomain falls to the wildcard, answered with the base
		// domain's address rather than an empty record.
		if got := queryA(t, addr, "other.example.com"); got != baseIP {
			t.Errorf("rules=%v: other.example.com resolved to %q, want the base %s", rules, got, baseIP)
		}
	}
}

// A wildcard rule on its own must still answer with an address.
func TestBuildAllowNet_WildcardAloneResolvesSubdomains(t *testing.T) {
	const baseIP = "203.0.113.40"
	lookup := func(_ context.Context, host string) ([]net.IP, error) {
		if host != "example.com" {
			return nil, fmt.Errorf("unexpected lookup for %q", host)
		}
		return []net.IP{net.ParseIP(baseIP)}, nil
	}

	res := buildAllowNetWithResolver([]string{"*.example.com"}, lookup)
	addr := serveZones(t, res.zones)

	if got := queryA(t, addr, "foo.example.com"); got != baseIP {
		t.Fatalf("foo.example.com resolved to %q, want %s", got, baseIP)
	}
}

// TestBuildAllowNet_DeeperZoneInheritsParentWildcard covers the zone an exact
// rule introduces underneath a wildcard.
//
// "api.team.example.test" creates zone "team.example.test.", which suffix-
// matches every sibling under it. Since the resolver answers from the first
// matching zone alone, that zone must carry the coverage "*.example.test"
// already grants — otherwise adding one exact rule silently sinkholes the
// siblings, and DNS disagrees with the egress filter, whose MatchesHostname
// suffix-matches at any depth.
func TestBuildAllowNet_DeeperZoneInheritsParentWildcard(t *testing.T) {
	const (
		baseIP  = "203.0.113.50"
		exactIP = "203.0.113.51"
	)
	lookup := func(_ context.Context, host string) ([]net.IP, error) {
		switch host {
		case "example.test":
			return []net.IP{net.ParseIP(baseIP)}, nil
		case "api.team.example.test":
			return []net.IP{net.ParseIP(exactIP)}, nil
		}
		return nil, fmt.Errorf("unexpected lookup for %q", host)
	}

	res := buildAllowNetWithResolver(
		[]string{"*.example.test", "api.team.example.test"},
		lookup,
	)
	addr := serveZones(t, res.zones)

	if got := queryA(t, addr, "api.team.example.test"); got != exactIP {
		t.Errorf("the exact rule's own resolution must win, got %q want %s", got, exactIP)
	}
	if got := queryA(t, addr, "other.team.example.test"); got != baseIP {
		t.Errorf("a sibling still covered by *.example.test was sinkholed: got %q want %s", got, baseIP)
	}
	if got := queryA(t, addr, "elsewhere.example.test"); got != baseIP {
		t.Errorf("the wildcard's own zone must keep working, got %q want %s", got, baseIP)
	}
	// Outside the wildcard entirely.
	if got := queryA(t, addr, "example.org"); got != "0.0.0.0" {
		t.Errorf("an unrelated host must still be sinkholed, got %q", got)
	}
}

// TestBuildAllowNet_DuplicateHostResolvesOnce pins the coupling contract for
// two rules naming one host.
//
// "github.test:443" and "github.test" are the same canonical name. Resolving
// twice would
// put both answers in the zone and leave the pin holding only the last, so a
// round-robin host would resolve to an address AllowHostToIP rejects — the
// allowed host blocked, intermittently. The resolver here returns a fresh
// address per call, so a second lookup cannot go unnoticed.
func TestBuildAllowNet_DuplicateHostResolvesOnce(t *testing.T) {
	calls := 0
	lookup := func(_ context.Context, host string) ([]net.IP, error) {
		if host != "github.test" {
			return nil, fmt.Errorf("unexpected lookup for %q", host)
		}
		calls++
		return []net.IP{net.IPv4(203, 0, 113, byte(100+calls))}, nil
	}

	res := buildAllowNetWithResolver([]string{"github.test:443", "github.test"}, lookup)
	if calls != 1 {
		t.Fatalf("resolved github.test %d times, want 1", calls)
	}

	pinned := res.exactIPs["github.test"]
	if len(pinned) != 1 {
		t.Fatalf("pin holds %v, want exactly one address", pinned)
	}

	addr := serveZones(t, res.zones)
	served := queryA(t, addr, "github.test")
	if served != pinned[0].String() {
		t.Fatalf("DNS serves %q but the egress pin permits %q; the guest would be blocked",
			served, pinned[0])
	}
}

// TestBuildAllowNet_BothSpellingsOfAHostStayReachable covers one host written
// two ways.
//
// The resolver compares zone suffixes and record names case-sensitively, so
// the two spellings are two distinct rules and each answers only its own
// query. The pin maps are keyed on the folded name, so they must hold the
// union of both resolutions: keeping only the last would make DNS serve an
// address AllowHostToIP then rejects. Each spelling is queried — checking one
// only would pass whichever resolution happened to land last.
func TestBuildAllowNet_BothSpellingsOfAHostStayReachable(t *testing.T) {
	newCountingResolver := func() func(context.Context, string) ([]net.IP, error) {
		calls := 0
		return func(_ context.Context, _ string) ([]net.IP, error) {
			calls++
			return []net.IP{net.IPv4(203, 0, 113, byte(60+calls))}, nil
		}
	}

	assertServedIsPinned := func(t *testing.T, addr, query string, pinned []net.IP) {
		t.Helper()
		served := queryA(t, addr, query)
		if served == "0.0.0.0" || served == "" || served == "<nil>" {
			t.Fatalf("%s got no usable answer (%q)", query, served)
		}
		for _, ip := range pinned {
			if ip.String() == served {
				return
			}
		}
		t.Fatalf("DNS served %q for %s but the pin permits %v; the guest would be blocked",
			served, query, pinned)
	}

	t.Run("exact rules", func(t *testing.T) {
		res := buildAllowNetWithResolver([]string{"GitHub.test", "github.test"}, newCountingResolver())
		addr := serveZones(t, res.zones)
		for _, query := range []string{"github.test", "GitHub.test"} {
			assertServedIsPinned(t, addr, query, res.exactIPs["github.test"])
		}
	})

	t.Run("wildcard rules", func(t *testing.T) {
		res := buildAllowNetWithResolver([]string{"*.Example.test", "*.example.test"}, newCountingResolver())
		addr := serveZones(t, res.zones)
		for _, query := range []string{"sub.example.test", "sub.Example.test"} {
			assertServedIsPinned(t, addr, query, res.suffixIPs[".example.test"])
		}
	})
}

// TestBuildAllowNet_NestedWildcardInheritanceIsDeterministic pins which
// wildcard a deeper zone inherits from.
//
// Zone "deep.sub.example.test." is created by an exact rule and covered by two
// wildcards. suffixIPs is a map, so taking every match in range order would let
// a sibling's answer flip between the two wildcards' addresses from one build
// to the next. The most specific wildcard wins, as it does for zone selection.
func TestBuildAllowNet_NestedWildcardInheritanceIsDeterministic(t *testing.T) {
	const (
		wideIP   = "203.0.113.70"
		narrowIP = "203.0.113.71"
		exactIP  = "203.0.113.72"
	)
	lookup := func(_ context.Context, host string) ([]net.IP, error) {
		switch host {
		case "example.test":
			return []net.IP{net.ParseIP(wideIP)}, nil
		case "sub.example.test":
			return []net.IP{net.ParseIP(narrowIP)}, nil
		case "api.deep.sub.example.test":
			return []net.IP{net.ParseIP(exactIP)}, nil
		}
		return nil, fmt.Errorf("unexpected lookup for %q", host)
	}

	for i := 0; i < 20; i++ {
		res := buildAllowNetWithResolver([]string{
			"*.example.test",
			"*.sub.example.test",
			"api.deep.sub.example.test",
		}, lookup)
		addr := serveZones(t, res.zones)

		if got := queryA(t, addr, "other.deep.sub.example.test"); got != narrowIP {
			t.Fatalf("iteration %d: sibling inherited %q, want the most specific wildcard %s",
				i, got, narrowIP)
		}
		if got := queryA(t, addr, "api.deep.sub.example.test"); got != exactIP {
			t.Fatalf("iteration %d: the exact rule resolved to %q, want %s", i, got, exactIP)
		}
	}
}

// TestBuildAllowNet_InheritanceSkipsAnUnresolvedWildcard covers a narrower
// wildcard whose own lookup failed. It has no address to hand down, so the
// zone must inherit from the broader wildcard that did resolve instead of
// being left with a bare sinkhole.
func TestBuildAllowNet_InheritanceSkipsAnUnresolvedWildcard(t *testing.T) {
	const wideIP = "203.0.113.80"
	lookup := func(_ context.Context, host string) ([]net.IP, error) {
		switch host {
		case "example.test":
			return []net.IP{net.ParseIP(wideIP)}, nil
		case "sub.example.test":
			return nil, fmt.Errorf("simulated resolution failure")
		case "api.deep.sub.example.test":
			return []net.IP{net.ParseIP("203.0.113.81")}, nil
		}
		return nil, fmt.Errorf("unexpected lookup for %q", host)
	}

	res := buildAllowNetWithResolver([]string{
		"*.example.test",
		"*.sub.example.test",
		"api.deep.sub.example.test",
	}, lookup)
	addr := serveZones(t, res.zones)

	if got := queryA(t, addr, "other.deep.sub.example.test"); got != wideIP {
		t.Fatalf("sibling resolved to %q, want the broader wildcard's %s", got, wideIP)
	}
}
