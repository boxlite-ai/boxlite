package main

import (
	"net"
	"testing"
)

func TestAllowNetMatcher_ExactHostname(t *testing.T) {
	m := NewAllowNetMatcher([]string{"api.openai.com", "api.anthropic.com"})

	if !m.MatchesHost("api.openai.com") {
		t.Error("should match exact hostname")
	}
	if !m.MatchesHost("API.OPENAI.COM") {
		t.Error("should match case-insensitive")
	}
	if m.MatchesHost("evil.com") {
		t.Error("should not match non-listed hostname")
	}
	if m.MatchesHost("openai.com") {
		t.Error("should not match parent domain")
	}
}

func TestAllowNetMatcher_WildcardSubdomain(t *testing.T) {
	m := NewAllowNetMatcher([]string{"*.example.com"})

	if !m.MatchesHost("api.example.com") {
		t.Error("should match subdomain")
	}
	if !m.MatchesHost("deep.sub.example.com") {
		t.Error("should match deep subdomain")
	}
	if m.MatchesHost("example.com") {
		t.Error("should not match base domain without wildcard prefix")
	}
	if m.MatchesHost("notexample.com") {
		t.Error("should not match different domain")
	}
}

func TestAllowNetMatcher_ExactIP(t *testing.T) {
	m := NewAllowNetMatcher([]string{"192.168.1.1", "10.0.0.1"})

	if !m.MatchesIP(net.ParseIP("192.168.1.1"), 0) {
		t.Error("should match exact IP")
	}
	if m.MatchesIP(net.ParseIP("192.168.1.2"), 0) {
		t.Error("should not match different IP")
	}
}

func TestAllowNetMatcher_CIDR(t *testing.T) {
	m := NewAllowNetMatcher([]string{"10.0.0.0/8"})

	if !m.MatchesIP(net.ParseIP("10.1.2.3"), 0) {
		t.Error("should match IP in CIDR range")
	}
	if !m.MatchesIP(net.ParseIP("10.255.255.255"), 0) {
		t.Error("should match IP at end of CIDR range")
	}
	if m.MatchesIP(net.ParseIP("11.0.0.1"), 0) {
		t.Error("should not match IP outside CIDR range")
	}
}

func TestAllowNetMatcher_HostPort(t *testing.T) {
	m := NewAllowNetMatcher([]string{"api.openai.com:443"})

	// Host is added to exact hosts for DNS resolution
	if !m.MatchesHost("api.openai.com") {
		t.Error("host:port rule should also match hostname")
	}
}

func TestAllowNetMatcher_DynamicIP(t *testing.T) {
	m := NewAllowNetMatcher([]string{"api.openai.com"})

	// Initially, IP is not in dynamic list
	if m.MatchesIP(net.ParseIP("1.2.3.4"), 0) {
		t.Error("should not match IP before DNS resolution")
	}

	// Simulate DNS resolution adding dynamic IP
	m.AddDynamicIP("1.2.3.4")

	if !m.MatchesIP(net.ParseIP("1.2.3.4"), 0) {
		t.Error("should match IP after adding to dynamic list")
	}
}

func TestAllowNetMatcher_EmptyAllowlist(t *testing.T) {
	m := NewAllowNetMatcher([]string{})

	if m.MatchesHost("anything.com") {
		t.Error("empty allowlist should match nothing")
	}
	if m.MatchesIP(net.ParseIP("1.2.3.4"), 0) {
		t.Error("empty allowlist should match no IPs")
	}
}

func TestAllowNetMatcher_TrailingDot(t *testing.T) {
	m := NewAllowNetMatcher([]string{"api.openai.com"})

	// DNS queries have trailing dot
	if !m.MatchesHost("api.openai.com.") {
		t.Error("should match hostname with trailing dot")
	}
}

func TestAllowNetMatcher_MixedRules(t *testing.T) {
	m := NewAllowNetMatcher([]string{
		"api.openai.com",
		"*.anthropic.com",
		"192.168.1.0/24",
		"10.0.0.1",
	})

	if !m.MatchesHost("api.openai.com") {
		t.Error("exact hostname")
	}
	if !m.MatchesHost("api.anthropic.com") {
		t.Error("wildcard subdomain")
	}
	if !m.MatchesIP(net.ParseIP("192.168.1.100"), 0) {
		t.Error("CIDR range")
	}
	if !m.MatchesIP(net.ParseIP("10.0.0.1"), 0) {
		t.Error("exact IP")
	}
	if m.MatchesHost("evil.com") {
		t.Error("unlisted host")
	}
	if m.MatchesIP(net.ParseIP("172.16.0.1"), 0) {
		t.Error("unlisted IP")
	}
}

func TestBuildAllowNetDNSZones(t *testing.T) {
	zones := buildAllowNetDNSZones([]string{
		"api.openai.com",
		"*.anthropic.com",
		"192.168.1.1", // IP — should be skipped (DNS only handles hostnames)
	})

	// Should have at least 1 specific zone + 1 catch-all root zone
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

func TestBuildAllowNetDNSZones_EmptyList(t *testing.T) {
	zones := buildAllowNetDNSZones([]string{})

	// Should have only the catch-all root zone
	if len(zones) != 1 {
		t.Errorf("expected 1 zone (root only), got %d", len(zones))
	}
	if zones[0].Name != "" {
		t.Errorf("single zone should be root, got %q", zones[0].Name)
	}
}
