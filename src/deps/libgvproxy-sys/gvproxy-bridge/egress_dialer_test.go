package main

import (
	"context"
	"errors"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

// dialRecorder is the socket seam for egressDialer tests: it records every
// address the dialer tries and answers from a script, so no packet leaves the
// process.
type dialRecorder struct {
	mu     sync.Mutex // the forwarder dials on a stack goroutine
	dialed []string
	fail   map[string]error         // addr → error; unlisted addrs succeed
	block  map[string]bool          // addr → blackhole: answer only when the attempt's context ends
	slow   map[string]time.Duration // addr → connects only after this much of its window
}

func (r *dialRecorder) dial(ctx context.Context, network, addr string) (net.Conn, error) {
	r.mu.Lock()
	r.dialed = append(r.dialed, network+" "+addr)
	err, failing := r.fail[addr]
	blackholed := r.block[addr]
	r.mu.Unlock()
	// net.Dialer.DialContext refuses an already-expired context instead of
	// connecting. The seam must do the same, or a starved attempt is
	// indistinguishable from a healthy one and the test proves nothing.
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if blackholed {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	if after, ok := r.slowFor(addr); ok {
		select {
		case <-time.After(after):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if failing {
		return nil, err
	}
	client, server := net.Pipe()
	_ = server.Close()
	return client, nil
}

func (r *dialRecorder) slowFor(addr string) (time.Duration, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	d, ok := r.slow[addr]
	return d, ok
}

// snapshot returns what has been dialed so far.
func (r *dialRecorder) snapshot() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.dialed...)
}

func staticResolve(ips ...string) resolveFunc {
	return func(context.Context, string) ([]net.IP, error) {
		out := make([]net.IP, 0, len(ips))
		for _, s := range ips {
			out = append(out, net.ParseIP(s))
		}
		return out, nil
	}
}

func newTestEgressDialer(t *testing.T, filter *AllowNetFilter, resolve resolveFunc) (*egressDialer, *dialRecorder) {
	t.Helper()
	d, err := newEgressDialer(filter, testGvproxyConfig().Subnet)
	if err != nil {
		t.Fatalf("newEgressDialer: %v", err)
	}
	rec := &dialRecorder{
		fail:  map[string]error{},
		block: map[string]bool{},
		slow:  map[string]time.Duration{},
	}
	d.resolve = resolve
	d.dial = rec.dial
	return d, rec
}

func TestEgressDialer_DialsResolvedAddressesInOrderUntilOneConnects(t *testing.T) {
	d, rec := newTestEgressDialer(t, testFilter("api.example.test"), staticResolve("198.51.100.1", "198.51.100.2", "198.51.100.3"))
	rec.fail["198.51.100.1:443"] = errors.New("connection refused")

	conn, err := d.DialHost(context.Background(), "api.example.test", 443)
	if err != nil {
		t.Fatalf("DialHost: %v", err)
	}
	_ = conn.Close()
	want := []string{"tcp4 198.51.100.1:443", "tcp4 198.51.100.2:443"}
	if strings.Join(rec.dialed, ",") != strings.Join(want, ",") {
		t.Fatalf("dialed %v, want %v (stop at the first success, never touch the third)", rec.dialed, want)
	}
}

// The split itself, away from the clock: candidateDeadline is what decides
// how much of the remaining budget one address may spend.
func TestCandidateDeadline_SplitsTheRemainingBudget(t *testing.T) {
	restore := minCandidateDialWindow
	minCandidateDialWindow = 2 * time.Second
	t.Cleanup(func() { minCandidateDialWindow = restore })

	now := time.Now()
	for _, tc := range []struct {
		name      string
		left      time.Duration
		remaining int
		wantShare time.Duration
	}{
		{"split across the addresses still to try", 30 * time.Second, 3, 10 * time.Second},
		{"the last address may spend what is left", 30 * time.Second, 1, 30 * time.Second},
		{"a share under the floor is raised to it, cutting the list short", 30 * time.Second, 60, 2 * time.Second},
		{"a budget under the floor goes to one address", 500 * time.Millisecond, 4, 500 * time.Millisecond},
	} {
		t.Run(tc.name, func(t *testing.T) {
			share := candidateDeadline(now, now.Add(tc.left), tc.remaining).Sub(now)
			if share != tc.wantShare {
				t.Fatalf("share = %v, want %v", share, tc.wantShare)
			}
		})
	}
}

// One blackholed address must not spend the whole operation budget. Without a
// per-candidate share the first dial holds the single operation-wide context
// until it expires, and the healthy address behind it is handed a context that
// is already done — the failure net.dialSerial avoids by splitting the
// deadline with partialDeadline (go/src/net/dial.go:659).
func TestEgressDialer_BlackholedAddressDoesNotStarveTheNext(t *testing.T) {
	restoreTimeout := upstreamDialTimeout
	restoreWindow := minCandidateDialWindow
	upstreamDialTimeout = 200 * time.Millisecond
	minCandidateDialWindow = 10 * time.Millisecond
	t.Cleanup(func() {
		upstreamDialTimeout = restoreTimeout
		minCandidateDialWindow = restoreWindow
	})

	d, rec := newTestEgressDialer(t, testFilter("api.example.test"),
		staticResolve("198.51.100.1", "198.51.100.2"))
	rec.block["198.51.100.1:443"] = true

	conn, err := d.DialHost(context.Background(), "api.example.test", 443)
	if err != nil {
		t.Fatalf("the second address is healthy and must still be reached: %v", err)
	}
	_ = conn.Close()

	want := []string{"tcp4 198.51.100.1:443", "tcp4 198.51.100.2:443"}
	if strings.Join(rec.snapshot(), ",") != strings.Join(want, ",") {
		t.Fatalf("dialed %v, want %v", rec.snapshot(), want)
	}
}

// The share is against the addresses still to try, not the whole answer, so a
// candidate that fails fast hands its unused window to the rest. Dividing by
// the full count instead leaves the survivor half a budget it needs all of.
func TestEgressDialer_FastFailureHandsItsWindowToTheNext(t *testing.T) {
	restoreTimeout := upstreamDialTimeout
	restoreWindow := minCandidateDialWindow
	upstreamDialTimeout = 500 * time.Millisecond
	minCandidateDialWindow = time.Millisecond
	t.Cleanup(func() {
		upstreamDialTimeout = restoreTimeout
		minCandidateDialWindow = restoreWindow
	})

	d, rec := newTestEgressDialer(t, testFilter("api.example.test"),
		staticResolve("198.51.100.1", "198.51.100.2"))
	rec.fail["198.51.100.1:443"] = errors.New("connection refused")
	// More than the 250ms an even two-way split would leave, less than the
	// ~500ms the survivor inherits once the refusal returns its share.
	rec.slow["198.51.100.2:443"] = 300 * time.Millisecond

	conn, err := d.DialHost(context.Background(), "api.example.test", 443)
	if err != nil {
		t.Fatalf("the refused address returned its window; the second must have it: %v", err)
	}
	_ = conn.Close()
}

// A caller that has gone away stops the loop instead of burning one doomed
// attempt per remaining address.
func TestEgressDialer_CanceledCallerDialsNothing(t *testing.T) {
	d, rec := newTestEgressDialer(t, testFilter("api.example.test"),
		staticResolve("198.51.100.1", "198.51.100.2"))

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if _, err := d.DialHost(ctx, "api.example.test", 443); err == nil {
		t.Fatal("a canceled caller must not yield a connection")
	}
	if got := rec.snapshot(); len(got) != 0 {
		t.Fatalf("dialed %v after cancellation; the loop must stop first", got)
	}
}

func TestEgressDialer_RefusesUnroutableAnswersUnderAllowNet(t *testing.T) {
	cases := map[string]string{
		"0.0.0.1":         "unspecified",
		"127.0.0.1":       "loopback",
		"10.0.0.1":        "private",
		"172.16.5.5":      "private",
		"192.168.1.1":     "private",
		"169.254.169.254": "link-local",
		"100.64.0.1":      "cgnat",
		"224.0.0.1":       "multicast",
		"255.255.255.255": "broadcast",
	}
	for ip, wantReason := range cases {
		reason, refused := unroutableEgress(net.ParseIP(ip).To4())
		if !refused || reason != wantReason {
			t.Errorf("unroutableEgress(%s) = (%q, %v), want (%q, true)", ip, reason, refused, wantReason)
		}
		d, rec := newTestEgressDialer(t, testFilter("api.example.test"), staticResolve(ip))
		if _, err := d.DialHost(context.Background(), "api.example.test", 443); err == nil {
			t.Errorf("%s: expected DialHost to fail, dialed %v", ip, rec.dialed)
		}
		if len(rec.dialed) != 0 {
			t.Errorf("%s: must not be dialed, got %v", ip, rec.dialed)
		}
	}
	if reason, refused := unroutableEgress(net.ParseIP("198.51.100.1").To4()); refused {
		t.Fatalf("a public address must be routable, got refused as %q", reason)
	}
}

// Listing the range alongside the hostname is how a private destination is
// granted on purpose, so an explicit IP/CIDR rule re-admits what the
// classifier would refuse.
func TestEgressDialer_ExplicitIPRuleReadmitsPrivateAnswer(t *testing.T) {
	d, rec := newTestEgressDialer(t, testFilter("db.example.test", "10.0.0.0/8"), staticResolve("10.0.0.5"))

	conn, err := d.DialHost(context.Background(), "db.example.test", 5432)
	if err != nil {
		t.Fatalf("DialHost: %v", err)
	}
	_ = conn.Close()
	if len(rec.dialed) != 1 || rec.dialed[0] != "tcp4 10.0.0.5:5432" {
		t.Fatalf("dialed %v, want the listed private address", rec.dialed)
	}
}

// The virtual network's own addresses are never a by-name destination, even
// when an IP rule (or the filter's always-allow set) would pass them.
func TestEgressDialer_BoxSubnetNeverDialedByName(t *testing.T) {
	cfg := testGvproxyConfig()
	for _, ip := range []string{cfg.GatewayIP, cfg.GuestIP, cfg.HostIP} {
		d, rec := newTestEgressDialer(t, testFilter("api.example.test", cfg.Subnet), staticResolve(ip))
		if _, err := d.DialHost(context.Background(), "api.example.test", 443); err == nil {
			t.Errorf("%s: expected DialHost to fail", ip)
		}
		if len(rec.dialed) != 0 {
			t.Errorf("%s: must not be dialed, got %v", ip, rec.dialed)
		}
	}
	// Without an allow_net there is nothing else to refuse.
	d, rec := newTestEgressDialer(t, nil, staticResolve("10.0.0.5"))
	if _, err := d.DialHost(context.Background(), "internal.example.test", 443); err != nil {
		t.Fatalf("no allow_net: private answers are dialable, got %v", err)
	}
	if len(rec.dialed) != 1 {
		t.Fatalf("no allow_net: expected one dial, got %v", rec.dialed)
	}
}

// Link-local is the one class no configuration re-admits. The guest-addressed
// forwarder drops 169.254.0.0/16 before consulting any rule (forked_tcp.go),
// so the by-name path must not become the way around it: not in secrets-only
// mode, where there is no filter at all, and not via an explicit CIDR rule.
func TestEgressDialer_LinkLocalRefusedOnEveryPath(t *testing.T) {
	cases := []struct {
		name   string
		filter *AllowNetFilter
	}{
		{"secrets-only, no allow_net", nil},
		{"hostname rule only", testFilter("imds.example.test")},
		{"link-local explicitly listed", testFilter("imds.example.test", "169.254.0.0/16")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d, rec := newTestEgressDialer(t, tc.filter, staticResolve("169.254.169.254"))
			if _, err := d.DialHost(context.Background(), "imds.example.test", 80); err == nil {
				t.Fatal("a name resolving into 169.254.0.0/16 must never be dialed")
			}
			if len(rec.dialed) != 0 {
				t.Fatalf("nothing may be dialed, got %v", rec.dialed)
			}
		})
	}
}

// A by-name dial is bounded end to end, resolution included. The MITM path
// hands this dial to http.Transport, whose DialContext carries only the
// proxied request's context, so a stalled host resolver would otherwise pin
// the connection with no ceiling of its own.
func TestEgressDialer_StalledResolverIsBounded(t *testing.T) {
	restore := upstreamDialTimeout
	upstreamDialTimeout = 50 * time.Millisecond
	t.Cleanup(func() { upstreamDialTimeout = restore })

	stalled := func(ctx context.Context, _ string) ([]net.IP, error) {
		<-ctx.Done() // never answers; only the bound ends this
		return nil, ctx.Err()
	}
	d, rec := newTestEgressDialer(t, testFilter("slow.example.test"), stalled)

	done := make(chan error, 1)
	go func() {
		_, err := d.DialHost(context.Background(), "slow.example.test", 443)
		done <- err
	}()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("a stalled resolver must not yield a connection")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("DialHost did not return: the by-name dial is unbounded")
	}
	if len(rec.dialed) != 0 {
		t.Fatalf("nothing may be dialed when resolution never completed, got %v", rec.dialed)
	}
}

func TestEgressDialer_IPv6OnlyAnswerIsNotDialable(t *testing.T) {
	d, rec := newTestEgressDialer(t, testFilter("v6.example.test"), staticResolve("2001:db8::1"))
	if _, err := d.DialHost(context.Background(), "v6.example.test", 443); err == nil {
		t.Fatal("expected an error: the guest network is IPv4-only")
	}
	if len(rec.dialed) != 0 {
		t.Fatalf("must not dial IPv6, got %v", rec.dialed)
	}
}

func TestEgressDialer_ResolverErrorMeansNoDial(t *testing.T) {
	failing := func(context.Context, string) ([]net.IP, error) { return nil, errors.New("SERVFAIL") }
	d, rec := newTestEgressDialer(t, testFilter("api.example.test"), failing)
	_, err := d.DialHost(context.Background(), "api.example.test", 443)
	if err == nil || !strings.Contains(err.Error(), "SERVFAIL") {
		t.Fatalf("expected the resolver error to surface, got %v", err)
	}
	if len(rec.dialed) != 0 {
		t.Fatalf("must not dial, got %v", rec.dialed)
	}
}
