// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package metrics

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	sdkboxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/prometheus/client_golang/prometheus"
)

// stubReader stands in for the BoxLite client so a failing or unusable reading
// is reachable — which is the half of this file that has no other way in.
type stubReader struct {
	metrics *sdkboxlite.RuntimeMetrics
	err     error
	calls   int
}

func (r *stubReader) Metrics(context.Context) (*sdkboxlite.RuntimeMetrics, error) {
	r.calls++
	return r.metrics, r.err
}

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// scraped reads a metric off the default registry — the same one the promhttp
// handler serves — so these tests see what a scrape would see rather than the
// atomic behind it.
func scraped(t *testing.T, name string) float64 {
	t.Helper()
	families, err := prometheus.DefaultGatherer.Gather()
	if err != nil {
		t.Fatalf("gather: %v", err)
	}
	for _, family := range families {
		if family.GetName() != name {
			continue
		}
		if len(family.GetMetric()) != 1 {
			t.Fatalf("%s has %d series, expected 1", name, len(family.GetMetric()))
		}
		metric := family.GetMetric()[0]
		switch {
		case metric.Counter != nil:
			return metric.GetCounter().GetValue()
		case metric.Gauge != nil:
			return metric.GetGauge().GetValue()
		default:
			t.Fatalf("%s is neither a counter nor a gauge", name)
		}
	}
	t.Fatalf("%s is not registered, so /metrics would not serve it", name)
	return 0
}

// sample drives one tick of the real sampler against a canned reading.
func sample(t *testing.T, reader *stubReader, at time.Time) {
	t.Helper()
	sampleRuntimeMetrics(context.Background(), reader, quietLogger(), at)
	if reader.calls == 0 {
		t.Fatal("the sampler did not read anything")
	}
}

// reset puts the package-level atomics back, so these tests do not hand their
// leftovers to whatever is added to this package next.
func reset(t *testing.T) {
	t.Helper()
	zeroSampledMetrics()
	// Both ends: cleaning up only afterwards would make a test that forgets
	// this call fail its neighbour instead of itself.
	t.Cleanup(zeroSampledMetrics)
}

func zeroSampledMetrics() {
	func() {
		sampledBoxesCreated.Store(0)
		sampledBoxesFailed.Store(0)
		sampledRunningBoxes.Store(0)
		sampledCommandsRun.Store(0)
		sampledExecErrors.Store(0)
		sampledAt.Store(0)
		runtimeSampleFailures.Store(0)
	}()
}

func TestAReadingReachesTheScrapeOutput(t *testing.T) {
	reset(t)

	sample(t, &stubReader{metrics: &sdkboxlite.RuntimeMetrics{
		BoxesCreatedTotal:     7,
		BoxesFailedTotal:      2,
		RunningBoxes:          3,
		TotalCommandsExecuted: 11,
		TotalExecErrors:       1,
	}}, time.Unix(1700000000, 0))

	for name, want := range map[string]float64{
		"boxes_created_total":                           7,
		"boxes_failed_total":                            2,
		"num_running_boxes":                             3,
		"total_commands_executed":                       11,
		"total_exec_errors":                             1,
		"runtime_metrics_last_sample_timestamp_seconds": 1700000000,
		"runtime_metrics_sample_failures_total":         0,
	} {
		if got := scraped(t, name); got != want {
			t.Errorf("%s = %v, want %v", name, got, want)
		}
	}
}

// A read that failed must leave every published value standing. Publishing
// anything — zeroes above all — would read as a counter reset to Prometheus and
// turn every rate() spanning that scrape into a spike.
//
// The last-sample stamp must not move either: together with the failure counter
// it is what separates a quiet runtime from a sampler that stopped getting
// answers.
func TestAFailedReadPublishesNothing(t *testing.T) {
	reset(t)
	sample(t, &stubReader{metrics: &sdkboxlite.RuntimeMetrics{BoxesCreatedTotal: 5}}, time.Unix(1700000000, 0))

	sample(t, &stubReader{err: errors.New("ffi exploded")}, time.Unix(1700000900, 0))

	if got := scraped(t, "boxes_created_total"); got != 5 {
		t.Errorf("boxes_created_total = %v, want the last usable reading of 5", got)
	}
	if got := scraped(t, "runtime_metrics_last_sample_timestamp_seconds"); got != 1700000000 {
		t.Errorf("last sample = %v, want the earlier one; a failed read has nothing to stamp", got)
	}
	if got := scraped(t, "runtime_metrics_sample_failures_total"); got != 1 {
		t.Errorf("failures = %v, want 1; an invisible failure looks like a quiet runtime", got)
	}
}

// A counter cannot be negative in core, which holds them as u64; it arrives
// negative when the 32-bit C ABI wraps. That is a reading that cannot be used,
// not a value to publish — and clamping it to zero would be the same counter
// reset a failed read must avoid.
func TestANegativeCounterIsTreatedAsAFailedRead(t *testing.T) {
	reset(t)
	sample(t, &stubReader{metrics: &sdkboxlite.RuntimeMetrics{BoxesCreatedTotal: 5}}, time.Unix(1700000000, 0))

	sample(t, &stubReader{metrics: &sdkboxlite.RuntimeMetrics{BoxesCreatedTotal: -1}}, time.Unix(1700000900, 0))

	if got := scraped(t, "boxes_created_total"); got != 5 {
		t.Errorf("boxes_created_total = %v, want the last usable reading of 5", got)
	}
	if got := scraped(t, "runtime_metrics_last_sample_timestamp_seconds"); got != 1700000000 {
		t.Errorf("last sample = %v, want the earlier one", got)
	}
	if got := scraped(t, "runtime_metrics_sample_failures_total"); got != 1 {
		t.Errorf("failures = %v, want 1", got)
	}
}

// Each counter has to be checked, and a four-row literal is exactly where a
// copy-paste slip lands — wiring `total_exec_errors` to the commands field
// would still reject a negative reading, just never the one it names.
func TestEveryCounterIsCheckedForTheWrap(t *testing.T) {
	for _, counter := range []struct {
		name    string
		reading sdkboxlite.RuntimeMetrics
	}{
		{"boxes_created_total", sdkboxlite.RuntimeMetrics{BoxesCreatedTotal: -1}},
		{"boxes_failed_total", sdkboxlite.RuntimeMetrics{BoxesFailedTotal: -1}},
		{"total_commands_executed", sdkboxlite.RuntimeMetrics{TotalCommandsExecuted: -1}},
		{"total_exec_errors", sdkboxlite.RuntimeMetrics{TotalExecErrors: -1}},
	} {
		t.Run(counter.name, func(t *testing.T) {
			reset(t)
			sample(t, &stubReader{metrics: &sdkboxlite.RuntimeMetrics{
				BoxesCreatedTotal:     5,
				BoxesFailedTotal:      5,
				TotalCommandsExecuted: 5,
				TotalExecErrors:       5,
			}}, time.Unix(1700000000, 0))

			reading := counter.reading
			sample(t, &stubReader{metrics: &reading}, time.Unix(1700000900, 0))

			if got := scraped(t, counter.name); got != 5 {
				t.Errorf("%s = %v, want the last usable reading of 5", counter.name, got)
			}
			if got := scraped(t, "runtime_metrics_sample_failures_total"); got != 1 {
				t.Errorf("failures = %v, want 1; %s was not checked", got, counter.name)
			}
		})
	}
}

// The gauge is exempt: core derives it as created − stopped − failed, so it is
// expected to move in both directions and a negative value there is not the
// overflow signature the counters carry.
func TestANegativeRunningCountDoesNotRejectTheReading(t *testing.T) {
	reset(t)

	sample(t, &stubReader{metrics: &sdkboxlite.RuntimeMetrics{
		BoxesCreatedTotal: 5,
		RunningBoxes:      -1,
	}}, time.Unix(1700000000, 0))

	if got := scraped(t, "num_running_boxes"); got != -1 {
		t.Errorf("num_running_boxes = %v, want -1 published as it came", got)
	}
	if got := scraped(t, "runtime_metrics_sample_failures_total"); got != 0 {
		t.Errorf("failures = %v, want 0; the gauge is not a counter", got)
	}
}
