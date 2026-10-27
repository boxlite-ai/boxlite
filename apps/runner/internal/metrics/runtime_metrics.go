// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package metrics

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"

	sdkboxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// How often the runtime's counters are read from core. They are cheap
// aggregate reads, but they cross the FFI boundary, so they are sampled on a
// timer rather than on every scrape.
const runtimeMetricsSnapshotInterval = 15 * time.Second

// The last usable reading of core's runtime counters, published to /metrics.
//
// Sampled into atomics by a goroutine and read from there at scrape time,
// rather than reaching into core when Prometheus asks. Two reasons, and the
// second is the load-bearing one:
//
//   - a scrape would otherwise block on an FFI call and whatever it waits for;
//   - CounterFunc cannot fail. A read that failed would still have to return
//     something, and any value it returned would be a claim. Returning 0 is the
//     worst of them: to Prometheus that is a counter reset, which turns every
//     rate() spanning that scrape into a spike. Holding the previous value is
//     the only answer that does not invent one.
//
// Which is why nothing below ever publishes a reading it does not trust. A
// reading that cannot be used leaves every counter where it was and is recorded
// as a failure instead.
var (
	sampledBoxesCreated   atomic.Uint64
	sampledBoxesFailed    atomic.Uint64
	sampledRunningBoxes   atomic.Int64
	sampledCommandsRun    atomic.Uint64
	sampledExecErrors     atomic.Uint64
	sampledAt             atomic.Int64
	runtimeSampleFailures atomic.Uint64
)

// The metric names are core's own, as the RuntimeMetrics schema in
// openapi/box.openapi.yaml spells them, so a number scraped here matches the
// same number read through core's own metrics endpoint without a translation
// table. That is also why total_commands_executed keeps its spelling rather
// than taking the _total suffix Prometheus convention would give a counter.
//
// Registered on the default registry at init, like the operation metrics in
// pkg/common, so the existing promhttp handler serves them with no wiring.
var (
	boxesCreatedCollector = promauto.NewCounterFunc(prometheus.CounterOpts{
		Name: "boxes_created_total",
		Help: "Boxes created by this runner's BoxLite runtime since it started",
	}, func() float64 { return float64(sampledBoxesCreated.Load()) })

	boxesFailedCollector = promauto.NewCounterFunc(prometheus.CounterOpts{
		Name: "boxes_failed_total",
		Help: "Boxes that failed to start on this runner since its runtime started",
	}, func() float64 { return float64(sampledBoxesFailed.Load()) })

	runningBoxesCollector = promauto.NewGaugeFunc(prometheus.GaugeOpts{
		Name: "num_running_boxes",
		Help: "Boxes currently running on this runner",
	}, func() float64 { return float64(sampledRunningBoxes.Load()) })

	commandsRunCollector = promauto.NewCounterFunc(prometheus.CounterOpts{
		Name: "total_commands_executed",
		Help: "Commands executed across all boxes on this runner since its runtime started",
	}, func() float64 { return float64(sampledCommandsRun.Load()) })

	execErrorsCollector = promauto.NewCounterFunc(prometheus.CounterOpts{
		Name: "total_exec_errors",
		Help: "Command execution errors across all boxes on this runner since its runtime started",
	}, func() float64 { return float64(sampledExecErrors.Load()) })

	// Without these two, a sampler that stopped working is indistinguishable
	// from a runtime that simply has not created a box lately: every counter
	// above would sit still and look healthy.
	lastSampleCollector = promauto.NewGaugeFunc(prometheus.GaugeOpts{
		Name: "runtime_metrics_last_sample_timestamp_seconds",
		Help: "When this runner last published a usable reading of its runtime counters; 0 before the first one",
	}, func() float64 { return float64(sampledAt.Load()) })

	sampleFailuresCollector = promauto.NewCounterFunc(prometheus.CounterOpts{
		Name: "runtime_metrics_sample_failures_total",
		Help: "Readings of the runtime counters that could not be used; the published values hold at the last one that could",
	}, func() float64 { return float64(runtimeSampleFailures.Load()) })
)

// runtimeMetricsReader is the slice of the BoxLite client the sampler needs,
// kept narrow so a failing read can be exercised without a live runtime.
type runtimeMetricsReader interface {
	Metrics(ctx context.Context) (*sdkboxlite.RuntimeMetrics, error)
}

func (c *Collector) snapshotRuntimeMetrics(ctx context.Context) {
	ticker := time.NewTicker(runtimeMetricsSnapshotInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			c.log.InfoContext(ctx, "Runtime metrics snapshotting stopped")
			return
		case <-ticker.C:
			sampleRuntimeMetrics(ctx, c.boxlite, c.log, time.Now())
		}
	}
}

// sampleRuntimeMetrics takes one reading and publishes it if it can be used.
//
// Everything a tick does, so the paths that decide not to publish are reachable
// from a test.
func sampleRuntimeMetrics(
	ctx context.Context,
	reader runtimeMetricsReader,
	log *slog.Logger,
	at time.Time,
) {
	metrics, err := reader.Metrics(ctx)
	if err != nil {
		recordUnusableReading(ctx, log, "Error reading runtime counters from BoxLite", "error", err)
		return
	}

	// A counter cannot be negative in core, which holds them as u64. It can
	// arrive negative here: the C ABI carries them as 32-bit ints
	// (sdks/c/src/metrics.rs casts each with `as c_int`), so a runtime past
	// 2^31 wraps on the way out. Nothing is broken, but the number is not the
	// count — so it is treated exactly like a read that failed rather than
	// clamped, because clamping to zero *is* the counter reset this whole
	// indirection exists to avoid.
	if negative := firstNegative(metrics); negative != "" {
		recordUnusableReading(ctx, log, "Runtime counter arrived negative, likely a 32-bit overflow in the C ABI", "counter", negative)
		return
	}

	sampledBoxesCreated.Store(uint64(metrics.BoxesCreatedTotal))
	sampledBoxesFailed.Store(uint64(metrics.BoxesFailedTotal))
	// The one gauge: core derives it as created − stopped − failed, so unlike
	// the counters it is expected to move in both directions.
	sampledRunningBoxes.Store(int64(metrics.RunningBoxes))
	sampledCommandsRun.Store(uint64(metrics.TotalCommandsExecuted))
	sampledExecErrors.Store(uint64(metrics.TotalExecErrors))
	sampledAt.Store(at.Unix())
}

// recordUnusableReading counts a reading that was not published and says so.
// The published counters and the last-sample stamp are deliberately untouched:
// between them they are what tells a reader the difference between a quiet
// runtime and a sampler that has stopped getting answers.
func recordUnusableReading(ctx context.Context, log *slog.Logger, message string, args ...any) {
	runtimeSampleFailures.Add(1)
	log.ErrorContext(ctx, message, args...)
}

// firstNegative names the counter that arrived negative, or "" if none did.
// `RunningBoxes` is not checked: it is the gauge, and core derives it.
func firstNegative(m *sdkboxlite.RuntimeMetrics) string {
	for _, counter := range []struct {
		name  string
		value int
	}{
		{"boxes_created_total", m.BoxesCreatedTotal},
		{"boxes_failed_total", m.BoxesFailedTotal},
		{"total_commands_executed", m.TotalCommandsExecuted},
		{"total_exec_errors", m.TotalExecErrors},
	} {
		if counter.value < 0 {
			return counter.name
		}
	}
	return ""
}
