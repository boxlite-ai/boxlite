package diskresize

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

// recordingHandler captures slog records so tests can assert on event logs
// without depending on output formatting.
type recordingHandler struct {
	mutex   sync.Mutex
	records []slog.Record
}

func (h *recordingHandler) Enabled(_ context.Context, _ slog.Level) bool { return true }

func (h *recordingHandler) Handle(_ context.Context, r slog.Record) error {
	h.mutex.Lock()
	defer h.mutex.Unlock()
	h.records = append(h.records, r.Clone())
	return nil
}

func (h *recordingHandler) WithAttrs(_ []slog.Attr) slog.Handler { return h }

func (h *recordingHandler) WithGroup(name string) slog.Handler {
	return h
}

func (h *recordingHandler) count(level slog.Level) int {
	h.mutex.Lock()
	defer h.mutex.Unlock()
	n := 0
	for _, r := range h.records {
		if r.Level == level {
			n++
		}
	}
	return n
}

func (h *recordingHandler) message() string {
	h.mutex.Lock()
	defer h.mutex.Unlock()
	var out strings.Builder
	for _, r := range h.records {
		out.WriteString(r.Message)
		out.WriteString("\n")
	}
	return out.String()
}

func newTestTicker(deviceBytes uint64, readErr error, resizeErr error) (*Ticker, *atomic.Int32, *atomic.Int32) {
	var reads, runs atomic.Int32
	ticker := New(Config{
		Logger:   slog.New(&recordingHandler{}),
		Interval: DefaultInterval,
		ReadDeviceSize: func(_ context.Context, _ string) (uint64, error) {
			reads.Add(1)
			return deviceBytes, readErr
		},
		RunResize: func(_ context.Context, _ string) error {
			runs.Add(1)
			return resizeErr
		},
	})
	return ticker, &reads, &runs
}

func TestTickStateMachine(t *testing.T) {
	ctx := context.Background()

	t.Run("first tick establishes the baseline with one resize2fs run", func(t *testing.T) {
		ticker, _, runs := newTestTicker(200*1024*1024*1024, nil, nil)
		ticker.tick(ctx)

		if got := runs.Load(); got != 1 {
			t.Fatalf("resize2fs runs = %d, want 1 (nil baseline forces one run)", got)
		}
		if ticker.lastDevBytes == nil || *ticker.lastDevBytes != 200*1024*1024*1024 {
			t.Fatalf("baseline = %v, want the observed device size", ticker.lastDevBytes)
		}
		if ticker.failures != 0 {
			t.Fatalf("failures = %d, want 0", ticker.failures)
		}
	})

	t.Run("unchanged device size skips resize2fs", func(t *testing.T) {
		ticker, reads, runs := newTestTicker(200*1024*1024*1024, nil, nil)
		ticker.tick(ctx)
		ticker.tick(ctx)
		ticker.tick(ctx)

		if got := runs.Load(); got != 1 {
			t.Fatalf("resize2fs runs = %d, want exactly 1 across three unchanged ticks", got)
		}
		if got := reads.Load(); got != 3 {
			t.Fatalf("device size reads = %d, want one sysfs read per tick (3 ticks)", got)
		}
	})

	t.Run("larger device size runs resize2fs and moves the baseline", func(t *testing.T) {
		ticker, reads, runs := newTestTicker(200*1024*1024*1024, nil, nil)
		ticker.tick(ctx)

		if got := runs.Load(); got != 1 {
			t.Fatalf("resize2fs runs = %d, want 1", got)
		}

		// Simulate the control plane growing the device.
		ticker.readDeviceSize = func(_ context.Context, _ string) (uint64, error) {
			reads.Add(1)
			return 250 * 1024 * 1024 * 1024, nil
		}
		ticker.tick(ctx)
		ticker.tick(ctx)

		if got := runs.Load(); got != 2 {
			t.Fatalf("resize2fs runs = %d, want 2 (grow, then steady)", got)
		}
		if ticker.lastDevBytes == nil || *ticker.lastDevBytes != 250*1024*1024*1024 {
			t.Fatalf("baseline = %v, want the new device size", ticker.lastDevBytes)
		}
	})

	t.Run("failed resize keeps the stale baseline and retries next tick", func(t *testing.T) {
		resizeErr := errors.New("resize2fs exited 4")
		ticker, _, runs := newTestTicker(200*1024*1024*1024, nil, resizeErr)
		ticker.tick(ctx)

		if got := runs.Load(); got != 1 {
			t.Fatalf("resize2fs runs = %d, want 1", got)
		}
		if ticker.lastDevBytes != nil {
			t.Fatalf("baseline = %v, want nil after a failed first resize", ticker.lastDevBytes)
		}
		if ticker.failures != 1 {
			t.Fatalf("failures = %d, want 1", ticker.failures)
		}

		// Next tick retries because the baseline is still stale.
		ticker.runResize = func(_ context.Context, _ string) error { runs.Add(1); return nil }
		ticker.tick(ctx)

		if got := runs.Load(); got != 2 {
			t.Fatalf("resize2fs runs = %d, want 2 (retry after failure)", got)
		}
		if ticker.lastDevBytes == nil {
			t.Fatalf("baseline = nil, want set after the successful retry")
		}
		if ticker.failures != 1 {
			t.Fatalf("failures = %d, want still 1 (the retry succeeded)", ticker.failures)
		}
	})

	t.Run("missing device skips without any resize attempt", func(t *testing.T) {
		missingErr := fmt.Errorf("%w: %s", ErrDeviceMissing, "/dev/disk/by-id/google-boxlite-data")
		ticker, _, runs := newTestTicker(0, missingErr, nil)
		ticker.tick(ctx)
		ticker.tick(ctx)
		ticker.tick(ctx)
		if got := runs.Load(); got != 0 {
			t.Fatalf("resize2fs runs = %d, want 0 on a host without the device", got)
		}
		if ticker.lastDevBytes != nil {
			t.Fatalf("baseline = %v, want nil", ticker.lastDevBytes)
		}
	})

	t.Run("transient read errors warn every tick without resizing", func(t *testing.T) {
		readErr := errors.New("read /sys/dev/block/8:16/size: permission denied")
		handler := &recordingHandler{}
		ticker, _, runs := newTestTicker(0, readErr, nil)
		ticker.log = slog.New(handler)

		ticker.tick(ctx)
		ticker.tick(ctx)

		if got := runs.Load(); got != 0 {
			t.Fatalf("resize2fs runs = %d, want 0 while the device size is unreadable", got)
		}
		if ticker.lastDevBytes != nil {
			t.Fatalf("baseline = %v, want nil while reads fail", ticker.lastDevBytes)
		}
		if got := handler.count(slog.LevelWarn); got != 2 {
			t.Fatalf("warn logs = %d, want one per failed tick (2 ticks)", got)
		}
		if got := handler.count(slog.LevelDebug); got != 0 {
			t.Fatalf("debug logs = %d, want 0 (only missing-device is a permanent skip)", got)
		}
	})

	t.Run("missing device logs debug once across repeated ticks", func(t *testing.T) {
		missingErr := fmt.Errorf("%w: %s", ErrDeviceMissing, "/dev/disk/by-id/google-boxlite-data")
		handler := &recordingHandler{}
		ticker, _, _ := newTestTicker(0, missingErr, nil)
		ticker.log = slog.New(handler)

		for i := 0; i < 5; i++ {
			ticker.tick(ctx)
		}
		logs := handler.message()
		if got := strings.Count(logs, "disk resize is disabled"); got != 1 {
			t.Fatalf("missing-device debug lines = %d, want exactly 1; logs:\n%s", got, logs)
		}
	})

	t.Run("first successful read logs the device observation once", func(t *testing.T) {
		handler := &recordingHandler{}
		ticker, _, _ := newTestTicker(200*1024*1024*1024, nil, nil)
		ticker.log = slog.New(handler)

		for i := 0; i < 3; i++ {
			ticker.tick(ctx)
		}

		logs := handler.message()
		if got := strings.Count(logs, "Data disk device observed"); got != 1 {
			t.Fatalf("device observation lines = %d, want exactly 1 across 3 successful ticks; logs:\n%s", got, logs)
		}
	})

	t.Run("missing device never logs the observation", func(t *testing.T) {
		missingErr := fmt.Errorf("%w: %s", ErrDeviceMissing, "/dev/disk/by-id/google-boxlite-data")
		handler := &recordingHandler{}
		ticker, _, runs := newTestTicker(0, missingErr, nil)
		ticker.log = slog.New(handler)

		for i := 0; i < 3; i++ {
			ticker.tick(ctx)
		}

		if got := strings.Count(handler.message(), "Data disk device observed"); got != 0 {
			t.Fatalf("device observation lines = %d, want 0 on a host without the device", got)
		}
		if got := runs.Load(); got != 0 {
			t.Fatalf("resize2fs runs = %d, want 0", got)
		}
	})
}
