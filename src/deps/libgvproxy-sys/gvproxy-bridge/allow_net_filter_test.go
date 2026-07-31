package main

import (
	"net"
	"sync"
	"testing"

	"gvisor.dev/gvisor/pkg/tcpip"
)

// testFilter builds a filter exactly the way gvproxy_create does, via the
// production newAllowNetFilter. Constructing NewAllowNetFilter directly here
// would let the set of always-allowed internal addresses drift between the
// tests and the box that actually runs.
func testFilter(rules ...string) *AllowNetFilter {
	cfg := testGvproxyConfig()
	cfg.AllowNet = rules
	return newAllowNetFilter(cfg)
}

func TestAllowNetFilter_ExactIP(t *testing.T) {
	f := testFilter("1.2.3.4", "5.6.7.8")
	assertTrue(t, f.MatchesIP(net.ParseIP("1.2.3.4")), "1.2.3.4 allowed")
	assertTrue(t, f.MatchesIP(net.ParseIP("5.6.7.8")), "5.6.7.8 allowed")
	assertFalse(t, f.MatchesIP(net.ParseIP("9.9.9.9")), "9.9.9.9 blocked")
}

func TestAllowNetFilter_CIDR(t *testing.T) {
	f := testFilter("10.0.0.0/8")
	assertTrue(t, f.MatchesIP(net.ParseIP("10.1.2.3")), "in range")
	assertTrue(t, f.MatchesIP(net.ParseIP("10.255.255.255")), "end of range")
	assertFalse(t, f.MatchesIP(net.ParseIP("11.0.0.1")), "out of range")
}

func TestAllowNetFilter_InternalIPsAlwaysAllowed(t *testing.T) {
	f := testFilter("1.2.3.4")
	assertTrue(t, f.MatchesIP(net.ParseIP("192.168.127.1")), "gateway always allowed")
	assertTrue(t, f.MatchesIP(net.ParseIP("192.168.127.2")), "guest always allowed")
}

// The host alias is not an internal address: it NATs to the host's loopback,
// so an unlisted alias must be denied like any other destination.
func TestAllowNetFilter_HostAliasObeysAllowlist(t *testing.T) {
	assertFalse(t, testFilter("1.2.3.4").MatchesIP(net.ParseIP("192.168.127.254")),
		"host alias denied when the allowlist does not cover it")
	assertTrue(t, testFilter("192.168.127.254").MatchesIP(net.ParseIP("192.168.127.254")),
		"host alias allowed once listed")
	assertTrue(t, testFilter("192.168.127.0/24").MatchesIP(net.ParseIP("192.168.127.254")),
		"host alias allowed by a covering CIDR")
}

func TestAllowNetFilter_NilWhenEmpty(t *testing.T) {
	f := testFilter()
	if f != nil {
		t.Error("empty rules should return nil filter")
	}
}

func TestAllowNetFilter_ExactHostname(t *testing.T) {
	f := testFilter("api.openai.com")
	assertTrue(t, f.MatchesHostname("api.openai.com"), "exact match")
	assertTrue(t, f.MatchesHostname("API.OPENAI.COM"), "case insensitive")
	assertFalse(t, f.MatchesHostname("evil.com"), "not in list")
	assertFalse(t, f.MatchesHostname("openai.com"), "parent domain not matched")
	assertTrue(t, f.HasHostnameRules(), "should have hostname rules")
}

func TestAllowNetFilter_Wildcard(t *testing.T) {
	f := testFilter("*.example.com")
	assertTrue(t, f.MatchesHostname("api.example.com"), "subdomain matched")
	assertTrue(t, f.MatchesHostname("deep.sub.example.com"), "deep subdomain matched")
	assertFalse(t, f.MatchesHostname("example.com"), "base domain not matched by wildcard")
	assertFalse(t, f.MatchesHostname("notexample.com"), "different domain not matched")
}

func TestAllowNetFilter_IPOnlyNoHostnameRules(t *testing.T) {
	f := testFilter("1.2.3.4", "10.0.0.0/8")
	assertFalse(t, f.HasHostnameRules(), "IP-only rules have no hostname rules")
}

func TestAllowNetFilter_MixedRules(t *testing.T) {
	f := testFilter(
		"1.2.3.4",
		"10.0.0.0/8",
		"api.openai.com",
		"*.anthropic.com",
	)
	assertTrue(t, f.MatchesIP(net.ParseIP("1.2.3.4")), "exact IP")
	assertTrue(t, f.MatchesIP(net.ParseIP("10.50.0.1")), "CIDR")
	assertTrue(t, f.MatchesHostname("api.openai.com"), "exact hostname")
	assertTrue(t, f.MatchesHostname("api.anthropic.com"), "wildcard hostname")
	assertTrue(t, f.HasHostnameRules(), "has hostname rules")
}

func TestAllowNetFilter_TrailingDotStripped(t *testing.T) {
	f := testFilter("api.openai.com")
	assertTrue(t, f.MatchesHostname("api.openai.com."), "trailing dot stripped")
}

func TestAllowNetFilter_HostWithPort(t *testing.T) {
	f := testFilter("api.openai.com:443")
	assertTrue(t, f.MatchesHostname("api.openai.com"), "port stripped from rule")
	assertTrue(t, f.HasHostnameRules(), "should have hostname rules")
}

func TestAllowNetFilter_EmptyHostname(t *testing.T) {
	f := testFilter("api.openai.com")
	assertFalse(t, f.MatchesHostname(""), "empty hostname never matches")
}

func TestDecideTCPRoute_CIDRUsesStandardForward(t *testing.T) {
	f := testFilter("104.18.26.0/24")

	inRange := net.IP([]byte{104, 18, 26, 120})
	if got := decideTCPRoute(inRange, 80, f, nil); got != tcpRouteStandardForward {
		t.Fatalf("expected in-range CIDR traffic to standard-forward, got %v", got)
	}

	outOfRange := net.IP([]byte{104, 18, 3, 24})
	if got := decideTCPRoute(outOfRange, 80, f, nil); got != tcpRouteBlock {
		t.Fatalf("expected out-of-range CIDR traffic to block, got %v", got)
	}
}

func TestResolveTCPDestination_HostAliasUsesPreNATIPForPolicy(t *testing.T) {
	filter := testFilter("example.com")
	hostAlias := tcpip.AddrFrom4Slice(net.ParseIP("192.168.127.254").To4())
	loopback := tcpip.AddrFrom4Slice(net.ParseIP("127.0.0.1").To4())
	nat := map[tcpip.Address]tcpip.Address{
		hostAlias: loopback,
	}

	policyIP, dialAddress := resolveTCPDestination(hostAlias, nat, &sync.Mutex{})

	if !policyIP.Equal(net.ParseIP("192.168.127.254")) {
		t.Fatalf("expected policy IP to remain host alias, got %v", policyIP)
	}
	// The pre-NAT address is what the allowlist is matched against, so an
	// allowlist that does not name the alias blocks it. Port 8080 keeps this
	// on the address path: 80 and 443 would route to SNI/Host inspection,
	// which is the hostname mechanism rather than the address check.
	if got := decideTCPRoute(policyIP, 8080, filter, nil); got != tcpRouteBlock {
		t.Fatalf("expected an unlisted host alias to be blocked, got %v", got)
	}
	// An allowlist that does name it forwards, on any port.
	if got := decideTCPRoute(policyIP, 8080, testFilter("192.168.127.254"), nil); got != tcpRouteStandardForward {
		t.Fatalf("expected a listed host alias to standard-forward, got %v", got)
	}

	dialIPBytes := dialAddress.As4()
	dialIP := net.IP(dialIPBytes[:])
	if !dialIP.Equal(net.ParseIP("127.0.0.1")) {
		t.Fatalf("expected dial destination to use NAT loopback, got %v", dialIP)
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
