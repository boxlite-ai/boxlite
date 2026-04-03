package main

import (
	"net"
	"testing"
)

func TestTCPFilter_ExactIP(t *testing.T) {
	f := NewTCPFilter([]string{"1.2.3.4", "5.6.7.8"}, "192.168.127.1", "192.168.127.2")
	assertTrue(t, f.MatchesIP(net.ParseIP("1.2.3.4")), "1.2.3.4 allowed")
	assertTrue(t, f.MatchesIP(net.ParseIP("5.6.7.8")), "5.6.7.8 allowed")
	assertFalse(t, f.MatchesIP(net.ParseIP("9.9.9.9")), "9.9.9.9 blocked")
}

func TestTCPFilter_CIDR(t *testing.T) {
	f := NewTCPFilter([]string{"10.0.0.0/8"}, "192.168.127.1", "192.168.127.2")
	assertTrue(t, f.MatchesIP(net.ParseIP("10.1.2.3")), "in range")
	assertTrue(t, f.MatchesIP(net.ParseIP("10.255.255.255")), "end of range")
	assertFalse(t, f.MatchesIP(net.ParseIP("11.0.0.1")), "out of range")
}

func TestTCPFilter_InternalIPsAlwaysAllowed(t *testing.T) {
	f := NewTCPFilter([]string{"1.2.3.4"}, "192.168.127.1", "192.168.127.2")
	assertTrue(t, f.MatchesIP(net.ParseIP("192.168.127.1")), "gateway always allowed")
	assertTrue(t, f.MatchesIP(net.ParseIP("192.168.127.2")), "guest always allowed")
}

func TestTCPFilter_NilWhenEmpty(t *testing.T) {
	f := NewTCPFilter([]string{}, "192.168.127.1", "192.168.127.2")
	if f != nil {
		t.Error("empty rules should return nil filter")
	}
}

func TestTCPFilter_ExactHostname(t *testing.T) {
	f := NewTCPFilter([]string{"api.openai.com"}, "192.168.127.1", "192.168.127.2")
	assertTrue(t, f.MatchesHostname("api.openai.com"), "exact match")
	assertTrue(t, f.MatchesHostname("API.OPENAI.COM"), "case insensitive")
	assertFalse(t, f.MatchesHostname("evil.com"), "not in list")
	assertFalse(t, f.MatchesHostname("openai.com"), "parent domain not matched")
	assertTrue(t, f.HasHostnameRules(), "should have hostname rules")
}

func TestTCPFilter_Wildcard(t *testing.T) {
	f := NewTCPFilter([]string{"*.example.com"}, "192.168.127.1", "192.168.127.2")
	assertTrue(t, f.MatchesHostname("api.example.com"), "subdomain matched")
	assertTrue(t, f.MatchesHostname("deep.sub.example.com"), "deep subdomain matched")
	assertFalse(t, f.MatchesHostname("example.com"), "base domain not matched by wildcard")
	assertFalse(t, f.MatchesHostname("notexample.com"), "different domain not matched")
}

func TestTCPFilter_IPOnlyNoHostnameRules(t *testing.T) {
	f := NewTCPFilter([]string{"1.2.3.4", "10.0.0.0/8"}, "192.168.127.1", "192.168.127.2")
	assertFalse(t, f.HasHostnameRules(), "IP-only rules have no hostname rules")
}

func TestTCPFilter_MixedRules(t *testing.T) {
	f := NewTCPFilter([]string{
		"1.2.3.4",
		"10.0.0.0/8",
		"api.openai.com",
		"*.anthropic.com",
	}, "192.168.127.1", "192.168.127.2")
	assertTrue(t, f.MatchesIP(net.ParseIP("1.2.3.4")), "exact IP")
	assertTrue(t, f.MatchesIP(net.ParseIP("10.50.0.1")), "CIDR")
	assertTrue(t, f.MatchesHostname("api.openai.com"), "exact hostname")
	assertTrue(t, f.MatchesHostname("api.anthropic.com"), "wildcard hostname")
	assertTrue(t, f.HasHostnameRules(), "has hostname rules")
}

func TestTCPFilter_TrailingDotStripped(t *testing.T) {
	f := NewTCPFilter([]string{"api.openai.com"}, "192.168.127.1", "192.168.127.2")
	assertTrue(t, f.MatchesHostname("api.openai.com."), "trailing dot stripped")
}

func TestTCPFilter_HostWithPort(t *testing.T) {
	f := NewTCPFilter([]string{"api.openai.com:443"}, "192.168.127.1", "192.168.127.2")
	assertTrue(t, f.MatchesHostname("api.openai.com"), "port stripped from rule")
	assertTrue(t, f.HasHostnameRules(), "should have hostname rules")
}

func TestTCPFilter_EmptyHostname(t *testing.T) {
	f := NewTCPFilter([]string{"api.openai.com"}, "192.168.127.1", "192.168.127.2")
	assertFalse(t, f.MatchesHostname(""), "empty hostname never matches")
}

func TestDecideTCPRoute_CIDRUsesStandardForward(t *testing.T) {
	f := NewTCPFilter([]string{"104.18.26.0/24"}, "192.168.127.1", "192.168.127.2")

	inRange := net.IP([]byte{104, 18, 26, 120})
	if got := decideTCPRoute(inRange, 80, f, nil); got != tcpRouteStandardForward {
		t.Fatalf("expected in-range CIDR traffic to standard-forward, got %v", got)
	}

	outOfRange := net.IP([]byte{104, 18, 3, 24})
	if got := decideTCPRoute(outOfRange, 80, f, nil); got != tcpRouteBlock {
		t.Fatalf("expected out-of-range CIDR traffic to block, got %v", got)
	}
}

func assertTrue(t *testing.T, v bool, msg string) {
	t.Helper()
	if !v {
		t.Errorf("expected true: %s", msg)
	}
}

func assertFalse(t *testing.T, v bool, msg string) {
	t.Helper()
	if v {
		t.Errorf("expected false: %s", msg)
	}
}
