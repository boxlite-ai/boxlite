package main

import (
	"context"
	"net"
	"testing"
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
