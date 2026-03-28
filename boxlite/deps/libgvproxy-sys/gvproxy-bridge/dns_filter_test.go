package main

import (
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
