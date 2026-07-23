package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/containers/gvisor-tap-vsock/pkg/types"
)

func TestBuildAllowNetDNSZones(t *testing.T) {
	zones, err := buildAllowNetDNSZones([]string{
		"api.openai.com",
		"*.anthropic.com",
		"192.168.1.1", // IP — skipped (DNS only handles hostnames)
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

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
	zones, err := buildAllowNetDNSZones([]string{"example.com"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

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

// TestBuildAllowNetDNSZones_LongestSuffixWinsBeforeRoot pins the bug fix
// where an `iapi.merck.com` query was sometimes answered with `0.0.0.0`
// even though the host had been allow-listed. Root cause: gvisor-tap-vsock
// matches zones with first-suffix-wins (no most-specific preference), and
// our zones used to be emitted in Go map-iteration order, so a `com.`
// zone (created because `github.com` was allow-listed) could win the
// match for `iapi.merck.com.` and serve its DefaultIP=0.0.0.0 even
// though a `merck.com.` zone with the right record also existed.
//
// Sorting zones longest-name-first guarantees the most-specific suffix
// matches first.
//
// NOTE: uses fixedIPResolver (not real DNS) so the test is hermetic.
// The original version that called the real resolver via
// buildAllowNetDNSZones() died with NXDOMAIN whenever the test runner
// had no view of internal corp DNS (which is every CI machine on the
// public internet) — the test then failed for the WRONG reason and
// never exercised the sort logic it was meant to pin.
func TestBuildAllowNetDNSZones_LongestSuffixWinsBeforeRoot(t *testing.T) {
	res := &fixedIPResolver{ip: net.IPv4(1, 2, 3, 4)}
	zones, err := buildAllowNetDNSZonesWith([]string{
		"github.com",
		"api.github.com",
		"raw.githubusercontent.com",
		"codeload.github.com",
		"iapi.merck.com",
	}, res)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Walk zones in returned order; index of each zone name in the slice.
	indexOf := make(map[string]int, len(zones))
	for i, z := range zones {
		indexOf[z.Name] = i
	}

	// Sanity: all the expected zones are present (one per distinct DNS suffix).
	for _, name := range []string{"github.com.", "githubusercontent.com.", "merck.com.", "com."} {
		if _, ok := indexOf[name]; !ok {
			t.Fatalf("expected zone %q in result, got zones %v", name, indexOf)
		}
	}

	// merck.com. (10 chars) MUST come before com. (4 chars) so an
	// `iapi.merck.com.` query hits the merck.com. zone first.
	if indexOf["merck.com."] >= indexOf["com."] {
		t.Errorf("merck.com. (idx=%d) must precede com. (idx=%d) — first-match-wins matcher would otherwise sinkhole iapi.merck.com",
			indexOf["merck.com."], indexOf["com."])
	}
	// github.com. (11) MUST come before com. for the same reason
	if indexOf["github.com."] >= indexOf["com."] {
		t.Errorf("github.com. must precede com.")
	}
	// githubusercontent.com. (22) MUST come before com.
	if indexOf["githubusercontent.com."] >= indexOf["com."] {
		t.Errorf("githubusercontent.com. must precede com.")
	}
	// And the catch-all root zone "" must always be last.
	if zones[len(zones)-1].Name != "" {
		t.Errorf("expected root sinkhole zone last, got %q", zones[len(zones)-1].Name)
	}
}

// TestBuildAllowNetDNSZones_CatchAllRootZoneAlwaysLast pins the
// invariant the body of dns_filter.go states but never asserted:
// "Catch-all root zone: sinkhole everything not explicitly allowed"
// must be appended *after* every per-suffix zone, regardless of how
// long or short the explicit allow-list is. Without this, gvisor's
// first-match-wins matcher could let the empty zone hijack a query
// before reaching the merck.com / github.com per-suffix zone.
func TestBuildAllowNetDNSZones_CatchAllRootZoneAlwaysLast(t *testing.T) {
	res := &fixedIPResolver{ip: net.IPv4(1, 2, 3, 4)}

	for _, hosts := range [][]string{
		{"example.com"},
		{"a.b.c.example.com"},
		{"x.com", "y.org", "z.net", "very.deep.subdomain.example.io"},
		{},
	} {
		t.Run(fmt.Sprintf("%d_hosts", len(hosts)), func(t *testing.T) {
			zones, err := buildAllowNetDNSZonesWith(hosts, res)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(zones) == 0 {
				t.Fatal("expected at least the root catch-all zone")
			}
			last := zones[len(zones)-1]
			if last.Name != "" {
				t.Errorf("last zone must be root catch-all (Name==\"\"), got %q at index %d/%d",
					last.Name, len(zones)-1, len(zones))
			}
			if !last.DefaultIP.Equal(net.IPv4(0, 0, 0, 0)) {
				t.Errorf("catch-all DefaultIP must be 0.0.0.0 (sinkhole), got %v", last.DefaultIP)
			}
		})
	}
}

// fixedIPResolver returns the same IP for every lookup. Useful for
// tests that care about ordering / structure rather than resolution
// content. Keeps the suite hermetic — no dependency on real DNS,
// network reachability, or specific corporate domains.
type fixedIPResolver struct{ ip net.IP }

func (f *fixedIPResolver) LookupIPAddr(_ context.Context, _ string) ([]net.IPAddr, error) {
	return []net.IPAddr{{IP: f.ip}}, nil
}

func TestBuildAllowNetDNSZones_EmptyList(t *testing.T) {
	zones, err := buildAllowNetDNSZones([]string{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(zones) != 1 {
		t.Errorf("expected 1 zone (root only), got %d", len(zones))
	}
	if zones[0].Name != "" {
		t.Errorf("single zone should be root, got %q", zones[0].Name)
	}
}

// --- Test doubles for the resolver ----------------------------------------

// flakyResolver fails the first failBefore attempts per hostname, then
// succeeds with a fixed IP. Used to simulate a brief host-DNS hiccup
// during box.create (VPN flap, slow corp resolver, mDNSResponder churn).
type flakyResolver struct {
	failBefore  int                    // fail this many calls per host before succeeding
	calls       map[string]*int32      // per-host call counter
	failWith    error                  // error returned during the failing window
	successIPs  map[string][]net.IPAddr // per-host IPs returned on success (defaults to 1.2.3.4)
	attemptHook func(host string, n int32, ctx context.Context)
}

func newFlakyResolver(failBefore int, failWith error) *flakyResolver {
	return &flakyResolver{
		failBefore: failBefore,
		calls:      make(map[string]*int32),
		failWith:   failWith,
		successIPs: make(map[string][]net.IPAddr),
	}
}

func (f *flakyResolver) LookupIPAddr(ctx context.Context, host string) ([]net.IPAddr, error) {
	counter, ok := f.calls[host]
	if !ok {
		counter = new(int32)
		f.calls[host] = counter
	}
	n := atomic.AddInt32(counter, 1)
	if f.attemptHook != nil {
		f.attemptHook(host, n, ctx)
	}
	if int(n) <= f.failBefore {
		return nil, f.failWith
	}
	if ips, ok := f.successIPs[host]; ok {
		return ips, nil
	}
	return []net.IPAddr{{IP: net.IPv4(1, 2, 3, 4)}}, nil
}

func (f *flakyResolver) callsFor(host string) int {
	if c, ok := f.calls[host]; ok {
		return int(atomic.LoadInt32(c))
	}
	return 0
}

// alwaysFailResolver returns the configured error for every lookup.
type alwaysFailResolver struct {
	err   error
	calls int32
}

func (r *alwaysFailResolver) LookupIPAddr(_ context.Context, _ string) ([]net.IPAddr, error) {
	atomic.AddInt32(&r.calls, 1)
	return nil, r.err
}

// hangingResolver blocks until ctx is cancelled, then returns ctx.Err().
// Used to verify the per-attempt timeout actually fires.
type hangingResolver struct {
	calls int32
}

func (h *hangingResolver) LookupIPAddr(ctx context.Context, _ string) ([]net.IPAddr, error) {
	atomic.AddInt32(&h.calls, 1)
	<-ctx.Done()
	return nil, ctx.Err()
}

// --- Reproducer + behavior tests ------------------------------------------

// TestBuildAllowNetDNSZones_RetriesTransientResolverFailure is the
// reproducer for the intermittent "0.0.0.0 for an allow-listed host"
// bug. With the old single-shot lookup the first failure dropped the
// zone permanently; with retry we recover and bake the host's records.
func TestBuildAllowNetDNSZones_RetriesTransientResolverFailure(t *testing.T) {
	res := newFlakyResolver(2, errors.New("simulated transient DNS error"))

	zones, err := buildAllowNetDNSZonesWith([]string{"iapi.example.com"}, res)
	if err != nil {
		t.Fatalf("expected retry to recover, got error: %v", err)
	}

	if got := res.callsFor("iapi.example.com"); got != 3 {
		t.Errorf("expected 3 lookup attempts (2 fail + 1 success), got %d", got)
	}

	// Confirm the host got an A record — no silent zone drop.
	found := false
	for _, z := range zones {
		for _, r := range z.Records {
			if r.IP != nil && r.IP.Equal(net.IPv4(1, 2, 3, 4)) {
				found = true
			}
		}
	}
	if !found {
		t.Fatalf("expected iapi.example.com record in zones, got %+v", zones)
	}
}

// TestBuildAllowNetDNSZones_FailsClosedAfterRetries is the second half
// of the contract: when retries are exhausted, return an error so
// box.create aborts loudly instead of producing a half-baked sinkhole.
func TestBuildAllowNetDNSZones_FailsClosedAfterRetries(t *testing.T) {
	res := &alwaysFailResolver{err: errors.New("DNS server unreachable")}

	_, err := buildAllowNetDNSZonesWith([]string{"iapi.example.com"}, res)
	if err == nil {
		t.Fatal("expected error when every retry attempt fails, got nil")
	}
	if got := atomic.LoadInt32(&res.calls); int(got) != dnsLookupAttempts {
		t.Errorf("expected %d attempts, got %d", dnsLookupAttempts, got)
	}
}

// TestBuildAllowNetDNSZones_HonorsPerAttemptTimeout pins down the
// per-attempt context timeout: a hanging resolver must be cancelled per
// attempt (not just after the entire retry loop). We can't measure the
// exact 2s without slowing the suite, so we override it for the test.
func TestBuildAllowNetDNSZones_HonorsPerAttemptTimeout(t *testing.T) {
	origTimeout := dnsLookupAttemptTimeoutVar
	origBackoff := dnsLookupInitialBackoffVar
	t.Cleanup(func() {
		dnsLookupAttemptTimeoutVar = origTimeout
		dnsLookupInitialBackoffVar = origBackoff
	})
	dnsLookupAttemptTimeoutVar = 30 * time.Millisecond
	dnsLookupInitialBackoffVar = 1 * time.Millisecond

	res := &hangingResolver{}
	start := time.Now()
	_, err := buildAllowNetDNSZonesWith([]string{"slow.example.com"}, res)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected timeout error, got nil")
	}
	// Each attempt must terminate at the per-attempt timeout, not hang
	// forever; total time should be roughly attempts * timeout, not
	// unbounded. Generous upper bound to avoid flakes on slow CI.
	maxExpected := time.Duration(dnsLookupAttempts) * dnsLookupAttemptTimeoutVar * 4
	if elapsed > maxExpected {
		t.Errorf("retry loop took %v; expected <= %v (per-attempt timeout not honored?)", elapsed, maxExpected)
	}
	if got := atomic.LoadInt32(&res.calls); int(got) != dnsLookupAttempts {
		t.Errorf("expected %d attempts, got %d", dnsLookupAttempts, got)
	}
}

// TestBuildAllowNetDNSZones_PerHostFailureFailsAggregate makes sure
// that one bad host in a multi-host allow-list aborts the whole build.
// Previously the sinkhole would silently come up with allow_zones=N-1
// total_zones=N — exactly the symptom reported from production.
func TestBuildAllowNetDNSZones_PerHostFailureFailsAggregate(t *testing.T) {
	good := []net.IPAddr{{IP: net.IPv4(8, 8, 8, 8)}}
	res := &mixedResolver{
		good: map[string][]net.IPAddr{"github.com": good, "api.github.com": good},
		bad:  map[string]error{"iapi.example.com": errors.New("permafail")},
	}

	_, err := buildAllowNetDNSZonesWith(
		[]string{"github.com", "api.github.com", "iapi.example.com"},
		res,
	)
	if err == nil {
		t.Fatal("expected aggregate error when one host fails to resolve, got nil")
	}
	want := "iapi.example.com"
	if !contains(err.Error(), want) {
		t.Errorf("error %q should mention failing host %q", err.Error(), want)
	}
}

// mixedResolver returns canned IPs for some hosts and canned errors
// for others, with no retry-flakiness — every call has a deterministic
// outcome based on the host.
type mixedResolver struct {
	good map[string][]net.IPAddr
	bad  map[string]error
}

func (m *mixedResolver) LookupIPAddr(_ context.Context, host string) ([]net.IPAddr, error) {
	if err, ok := m.bad[host]; ok {
		return nil, err
	}
	if ips, ok := m.good[host]; ok {
		return ips, nil
	}
	return nil, fmt.Errorf("no test data for %q", host)
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || (len(sub) > 0 && indexOf(s, sub) >= 0))
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

// ─── End-to-end propagation through buildTapConfig ───────────────────────
//
// The PR body promises the fix "propagates resolver errors through
// buildAllowNetDNSZones → buildTapConfig → gvproxy_create". The
// resolver-level tests above cover the first leg; the tests here cover
// the second leg (buildAllowNetDNSZones → buildTapConfig). We can't
// exercise gvproxy_create directly from Go tests because it's a cgo
// //export function that requires a real Unix-socket path and an
// actual VM transport; the leg from buildTapConfig to gvproxy_create
// is a straight `if err != nil { return -1; setErr(err); }` block at
// main.go:418 — pinned implicitly by both buildTapConfig returning the
// error and the gvproxy_create_latency_test.go init-error coverage.
//
// Strategy: drive buildTapConfig with an allow_net entry that the
// system resolver is guaranteed to refuse (RFC 6761 reserved `.invalid`
// TLD always NXDOMAINs), override dnsLookupAttemptTimeoutVar /
// dnsLookupInitialBackoffVar to keep the test fast, observe that the
// error reaches the caller AND no half-baked config is returned.

// TestBuildTapConfig_DNSResolutionFailure_PropagatesErrorNotSilentConfig
// is the end-to-end fail-closed guard: a single bad allow_net host
// must cause buildTapConfig to surface the error (not return a
// "looks-fine" *types.Configuration with allow_zones=N-1 total_zones=N).
//
// Pre-fix (silent half-baked) behavior — what production reported:
//   gvproxy log line:  allow_zones=0 total_zones=1
//   box.create result: SUCCESS
//   guest behavior:    getent hosts allowed.host → 0.0.0.0
//
// Post-fix: buildTapConfig returns (nil, err) and the caller refuses to
// continue.
func TestBuildTapConfig_DNSResolutionFailure_PropagatesErrorNotSilentConfig(t *testing.T) {
	origTimeout := dnsLookupAttemptTimeoutVar
	origBackoff := dnsLookupInitialBackoffVar
	t.Cleanup(func() {
		dnsLookupAttemptTimeoutVar = origTimeout
		dnsLookupInitialBackoffVar = origBackoff
	})
	dnsLookupAttemptTimeoutVar = 200 * time.Millisecond
	dnsLookupInitialBackoffVar = 1 * time.Millisecond

	cfg := testGvproxyConfig()
	// RFC 6761 reserves `.invalid` — every conforming resolver MUST
	// return NXDOMAIN. Both glibc and systemd-resolved enforce it.
	cfg.AllowNet = []string{"nonexistent-pin-545-d8ac1b2.invalid"}

	tapCfg, err := buildTapConfig(cfg, types.QemuProtocol)

	if err == nil {
		t.Fatalf(
			"expected error from buildTapConfig when allow_net host doesn't resolve; "+
				"got nil err and tapCfg=%+v — this is the silent half-baked sinkhole the fix should prevent",
			tapCfg,
		)
	}
	if tapCfg != nil {
		t.Errorf(
			"expected nil tapCfg on DNS failure (caller must refuse to continue); got %+v",
			tapCfg,
		)
	}
	// Error must name the failing host so operators can act on the message.
	if !contains(err.Error(), "nonexistent-pin-545-d8ac1b2.invalid") {
		t.Errorf("error should name the failing host; got: %v", err)
	}
}

// TestBuildTapConfig_NoAllowNet_HappyPath_NoDNSLookup is the negative
// control for the test above: when allow_net is empty, buildTapConfig
// must NOT do any DNS lookups (no slow path even when host DNS is
// broken) and must return a usable config. Pins that the retry +
// fail-closed machinery only kicks in when allow_net is actually used.
func TestBuildTapConfig_NoAllowNet_HappyPath_NoDNSLookup(t *testing.T) {
	// Make any accidental real-DNS attempt fail loudly + slowly so a
	// regression that calls the resolver on the no-allow_net path
	// surfaces as a test timeout rather than passing silently.
	origTimeout := dnsLookupAttemptTimeoutVar
	t.Cleanup(func() { dnsLookupAttemptTimeoutVar = origTimeout })
	dnsLookupAttemptTimeoutVar = 50 * time.Millisecond

	cfg := testGvproxyConfig()
	cfg.AllowNet = nil // explicit: no DNS resolution should occur

	start := time.Now()
	tapCfg, err := buildTapConfig(cfg, types.QemuProtocol)
	elapsed := time.Since(start)

	if err != nil {
		t.Fatalf("unexpected error on no-allow_net path: %v", err)
	}
	if tapCfg == nil {
		t.Fatal("expected a valid *types.Configuration, got nil")
	}
	// Should be near-instant — only the in-process DNSZones static config.
	// Anything > 50ms suggests a resolver call slipped in.
	if elapsed > 50*time.Millisecond {
		t.Errorf("no-allow_net build took %v; expected near-instant — did a DNS lookup leak in?", elapsed)
	}
	// The hard-coded DNSZones from testGvproxyConfig must be present.
	if len(tapCfg.DNS) == 0 {
		t.Fatal("expected at least the hard-coded boxlite.internal. zone")
	}
}

// TestBuildTapConfig_ProductionSymptomReproducer is the exact wire-level
// reproducer of the symptom users reported: "box.create returns SUCCESS
// but allow_zones=N-1 total_zones=N in the gvproxy log, and the guest
// later sees getent hosts <allowed> → 0.0.0.0". Constructs the failure
// shape — N hosts in allow_net, one of them unresolvable — and asserts:
//   (a) Pre-fix path: would produce a config with len(DNS)=N (= silent
//       failure). Post-fix: returns error + nil config.
//   (b) Error message identifies WHICH host failed (so the operator can
//       fix their typo / DNS setup, not have to read gvproxy debug logs).
func TestBuildTapConfig_ProductionSymptomReproducer(t *testing.T) {
	origTimeout := dnsLookupAttemptTimeoutVar
	origBackoff := dnsLookupInitialBackoffVar
	t.Cleanup(func() {
		dnsLookupAttemptTimeoutVar = origTimeout
		dnsLookupInitialBackoffVar = origBackoff
	})
	dnsLookupAttemptTimeoutVar = 200 * time.Millisecond
	dnsLookupInitialBackoffVar = 1 * time.Millisecond

	cfg := testGvproxyConfig()
	// 3 hosts: 2 resolvable (mock via example.com — RFC 2606), 1 reserved-NXDOMAIN.
	// example.com & www.example.com are IANA-managed and ALWAYS resolve.
	cfg.AllowNet = []string{
		"example.com",
		"www.example.com",
		"pin-545-d8ac1b2.invalid", // RFC 6761 — guaranteed NXDOMAIN
	}

	tapCfg, err := buildTapConfig(cfg, types.QemuProtocol)

	// Verdict assertions
	if err == nil {
		// The exact "production silent half-baked sinkhole" shape — pin it.
		var allowZones, totalZones int
		if tapCfg != nil {
			totalZones = len(tapCfg.DNS)
			for _, z := range tapCfg.DNS {
				if z.Name != "" {
					allowZones++
				}
			}
		}
		t.Fatalf(
			"REGRESSION — fix gone: buildTapConfig returned a silent half-baked config "+
				"with allow_zones=%d total_zones=%d while one allow_net host failed to resolve. "+
				"This is the exact symptom users reported.",
			allowZones, totalZones,
		)
	}
	if tapCfg != nil {
		t.Errorf("expected nil tapCfg on failure (caller must abort); got %+v", tapCfg)
	}
	if !contains(err.Error(), "pin-545-d8ac1b2.invalid") {
		t.Errorf(
			"error must identify the failing host (operator-debuggable); got: %v",
			err,
		)
	}
}
