package main

import (
	"sort"
	"testing"
	"time"

	"github.com/containers/gvisor-tap-vsock/pkg/types"
	"github.com/containers/gvisor-tap-vsock/pkg/virtualnetwork"
)

// gvproxy_create blocks on `<-initErr` (main.go), which only fires once
// virtualnetwork.New has finished. So virtualnetwork.New's duration is the
// upper bound on the main-thread delay that wait adds: if New stays under
// the budget, the added wait does too. This guards the answer to the #612
// review question ("will this hurt performance in normal cases?") against a
// future regression that makes the synchronous init expensive.
//
// We assert the MEDIAN over several runs (not a single sample) so one-off GC
// or scheduler pauses don't flake the test, with a 0.5ms budget that leaves
// healthy headroom over the observed ~150µs for the normal (no-forwards)
// config.
func TestVirtualNetworkNewWithinLatencyBudget(t *testing.T) {
	const (
		iters  = 11
		budget = 500 * time.Microsecond
	)

	// Warm up once: the first construction pays one-time lazy-init costs
	// that are not representative of the steady-state per-box cost.
	if vn, err := virtualnetwork.New(buildTapConfig(testGvproxyConfig(), types.QemuProtocol)); err != nil {
		t.Fatalf("warmup virtualnetwork.New failed: %v", err)
	} else {
		_ = vn
	}

	samples := make([]time.Duration, 0, iters)
	for i := 0; i < iters; i++ {
		cfg := buildTapConfig(testGvproxyConfig(), types.QemuProtocol)
		start := time.Now()
		vn, err := virtualnetwork.New(cfg)
		elapsed := time.Since(start)
		if err != nil {
			t.Fatalf("iter %d: virtualnetwork.New failed: %v", i, err)
		}
		_ = vn
		samples = append(samples, elapsed)
	}

	sort.Slice(samples, func(i, j int) bool { return samples[i] < samples[j] })
	median := samples[len(samples)/2]
	t.Logf("virtualnetwork.New median=%v budget=%v samples=%v", median, budget, samples)

	if median > budget {
		t.Fatalf(
			"virtualnetwork.New median %v exceeds %v budget — the synchronous gvproxy_create `<-initErr` wait regressed",
			median, budget,
		)
	}
}
