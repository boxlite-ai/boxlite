package main

import (
	"net"
	"strings"
	"sync"
	"testing"

	"gvisor.dev/gvisor/pkg/tcpip"
)

// testFilter builds a filter exactly the way gvproxy_create does — via the
// production newAllowNetFilter, which owns the set of always-allowed internal
// addresses — but injects deterministic stub resolutions instead of real DNS
// lookups so the egress pin is testable offline. Going through the production
// constructor keeps that address set from drifting between tests and a box.
func testFilter(rules ...string) *AllowNetFilter {
	cfg := testGvproxyConfig()
	cfg.AllowNet = rules
	exact, wildcard := stubResolvedHostIPs(rules)
	return newAllowNetFilter(cfg, exact, wildcard)
}

// stubResolvedHostIPs assigns each hostname rule a deterministic IPv4 so
// AllowHostToIP can be exercised without real DNS. Exact hosts → 10.0.0.1;
// wildcard suffixes → 10.0.0.2. Keys mirror buildAllowNet (lowercased).
func stubResolvedHostIPs(rules []string) (map[string][]net.IP, map[string][]net.IP) {
	exact := make(map[string][]net.IP)
	wildcard := make(map[string][]net.IP)
	for _, rule := range rules {
		rule = strings.TrimSpace(rule)
		if rule == "" || net.ParseIP(rule) != nil {
			continue
		}
		if _, _, err := net.ParseCIDR(rule); err == nil {
			continue
		}
		host := rule
		if h, _, err := net.SplitHostPort(rule); err == nil {
			host = h
		}
		if strings.HasPrefix(host, "*.") {
			wildcard["."+strings.ToLower(host[2:])] = []net.IP{net.ParseIP("10.0.0.2").To4()}
			continue
		}
		exact[strings.ToLower(host)] = []net.IP{net.ParseIP("10.0.0.1").To4()}
	}
	return exact, wildcard
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

// TestAllowHostToIP_BlocksDomainFronting is the reproducer for the
// domain-fronting bypass: a guest dialing an attacker IP while presenting an
// allowed hostname must be rejected. With the old MatchesHostname-only gate,
// this hostname/IP decoupling let the connection through.
func TestAllowHostToIP_BlocksDomainFronting(t *testing.T) {
	f := testFilter("allowed.example")
	allowed := net.ParseIP("10.0.0.1") // stubResolvedHostIPs pins allowed.example here
	attacker := net.ParseIP("203.0.113.7")

	assertTrue(t, f.AllowHostToIP("allowed.example", allowed), "hostname + its resolved IP allowed")
	assertFalse(t, f.AllowHostToIP("allowed.example", attacker), "hostname + attacker IP blocked (domain fronting)")
}

func TestAllowHostToIP_ExactHostname(t *testing.T) {
	f := testFilter("api.example.com")
	assertTrue(t, f.AllowHostToIP("api.example.com", net.ParseIP("10.0.0.1")), "resolved IP allowed")
	assertFalse(t, f.AllowHostToIP("api.example.com", net.ParseIP("10.0.0.2")), "unresolved IP blocked")
	assertFalse(t, f.AllowHostToIP("other.example.com", net.ParseIP("10.0.0.1")), "unlisted hostname blocked")
}

func TestAllowHostToIP_Wildcard(t *testing.T) {
	f := testFilter("*.example.com")
	// stubResolvedHostIPs pins wildcard suffixes to 10.0.0.2.
	assertTrue(t, f.AllowHostToIP("foo.example.com", net.ParseIP("10.0.0.2")), "wildcard subdomain + base IP allowed")
	assertFalse(t, f.AllowHostToIP("foo.example.com", net.ParseIP("203.0.113.7")), "wildcard subdomain + attacker IP blocked")
	assertFalse(t, f.AllowHostToIP("evil.net", net.ParseIP("10.0.0.2")), "non-matching hostname blocked")
}

func TestAllowHostToIP_OverlappingWildcards_Union(t *testing.T) {
	// a.sub.example.com matches both *.example.com and *.sub.example.com. The
	// pin must accept destIP from either rule, not just whichever suffix is
	// listed first in wildcardSuffixes.
	f := NewAllowNetFilter([]string{"*.example.com", "*.sub.example.com"}, "192.168.127.1", "192.168.127.2")
	f.SetResolvedHostIPs(nil, map[string][]net.IP{
		".example.com":     {net.ParseIP("10.0.0.1").To4()},
		".sub.example.com": {net.ParseIP("10.0.0.9").To4()},
	})
	assertTrue(t, f.AllowHostToIP("a.sub.example.com", net.ParseIP("10.0.0.9")), "narrower wildcard's IP allowed")
	assertTrue(t, f.AllowHostToIP("a.sub.example.com", net.ParseIP("10.0.0.1")), "broader wildcard's IP allowed")
	assertFalse(t, f.AllowHostToIP("a.sub.example.com", net.ParseIP("203.0.113.7")), "unresolved IP blocked")
}

func TestAllowHostToIP_ExactRuleDoesNotShadowWildcard(t *testing.T) {
	// An exact rule whose DNS failed (empty pin) must not shadow a wildcard
	// that also covers the hostname: the union of matching rules still applies.
	f := NewAllowNetFilter([]string{"api.example.com", "*.example.com"}, "192.168.127.1", "192.168.127.2")
	f.SetResolvedHostIPs(
		map[string][]net.IP{"api.example.com": nil},
		map[string][]net.IP{".example.com": {net.ParseIP("10.0.0.1").To4()}},
	)
	assertTrue(t, f.AllowHostToIP("api.example.com", net.ParseIP("10.0.0.1")), "wildcard authorizes when exact rule has no pin")
	assertFalse(t, f.AllowHostToIP("api.example.com", net.ParseIP("203.0.113.7")), "unresolved IP still blocked")
}

func TestAllowHostToIP_EmptyOrMissingHostname(t *testing.T) {
	f := testFilter("api.example.com")
	assertFalse(t, f.AllowHostToIP("", net.ParseIP("10.0.0.1")), "empty hostname blocked")
	assertFalse(t, f.AllowHostToIP("api.example.com", nil), "nil IP blocked")
}

func TestAllowHostToIP_IPOnlyRulesUnaffected(t *testing.T) {
	// IP/CIDR-only allowlists have no hostname rules, so the pin is never
	// consulted; MatchesIP continues to govern (decideTCPRoute never routes
	// hostname inspection without HasHostnameRules).
	f := testFilter("1.2.3.4")
	assertFalse(t, f.HasHostnameRules(), "IP-only allowlist has no hostname rules")
	assertTrue(t, f.MatchesIP(net.ParseIP("1.2.3.4")), "IP rule still matches")
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
