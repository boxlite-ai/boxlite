// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package diskresize

import (
	"context"
	"errors"
	"log/slog"
	"time"
)

const (
	// DefaultInterval is the steady-state polling cadence (hyperdisk LLD §5.1).
	// Unchanged device sizes cost one sysfs read per interval.
	DefaultInterval = 10 * time.Second
	// DefaultDevicePath is the stable GCP data disk symlink; udev keeps it
	// pointing at the data disk regardless of the underlying device name.
	DefaultDevicePath = "/dev/disk/by-id/google-boxlite-data"
)

// ErrDeviceMissing is returned by the default size reader on hosts without the
// data disk device (AWS, local, or a non-Linux host). The ticker treats it as
// a permanent skip: disk resize is a GCP-only behavior.
var ErrDeviceMissing = errors.New("data disk device not found")

type Config struct {
	Logger *slog.Logger
	// Interval is the polling cadence; zero selects DefaultInterval.
	Interval time.Duration
	// DevicePath overrides DefaultDevicePath for tests and local runs.
	DevicePath string
	// ReadDeviceSize and RunResize replace the platform defaults in tests.
	ReadDeviceSize func(ctx context.Context, devicePath string) (uint64, error)
	RunResize      func(ctx context.Context, devicePath string) error
}

type Ticker struct {
	log            *slog.Logger
	interval       time.Duration
	devicePath     string
	readDeviceSize func(ctx context.Context, devicePath string) (uint64, error)
	runResize      func(ctx context.Context, devicePath string) error

	lastDevBytes  *uint64
	failures      int
	missingLogged bool
	// observed marks the first successful device-size read, which logs the
	// capacity once so operators can match it against the cloud console.
	observed bool
}

func New(cfg Config) *Ticker {
	logger := slog.Default()
	if cfg.Logger != nil {
		logger = cfg.Logger
	}
	interval := cfg.Interval
	if interval == 0 {
		interval = DefaultInterval
	}
	devicePath := cfg.DevicePath
	if devicePath == "" {
		devicePath = DefaultDevicePath
	}
	readDeviceSize := cfg.ReadDeviceSize
	if readDeviceSize == nil {
		readDeviceSize = defaultReadDeviceSize
	}
	runResize := cfg.RunResize
	if runResize == nil {
		runResize = defaultRunResize
	}

	return &Ticker{
		log:            logger.With(slog.String("component", "diskresize")),
		interval:       interval,
		devicePath:     devicePath,
		readDeviceSize: readDeviceSize,
		runResize:      runResize,
	}
}

// Run drives the resize loop until ctx is cancelled. The first round happens
// immediately: the nil baseline forces one resize2fs invocation, which is an
// idempotent no-op on an unchanged filesystem but repairs the backlog of any
// earlier resize that failed after the device had already grown.
func (t *Ticker) Run(ctx context.Context) {
	t.tick(ctx)

	ticker := time.NewTicker(t.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			t.log.InfoContext(ctx, "Disk resize ticker stopped")
			return
		case <-ticker.C:
			t.tick(ctx)
		}
	}
}

// tick performs one round: observe the device size, resize the filesystem if
// the size differs from the last observed baseline, and move the baseline only
// after a successful resize. A failed resize leaves the baseline stale, so the
// next round retries; missing-device is a permanent skip, everything else is a
// transient warn. Steady state (unchanged size) costs exactly one sysfs read.
func (t *Ticker) tick(ctx context.Context) {
	devBytes, err := t.readDeviceSize(ctx, t.devicePath)
	if err != nil {
		if errors.Is(err, ErrDeviceMissing) {
			t.logOnceMissing(ctx)
			return
		}
		t.log.WarnContext(ctx, "Failed to read data disk device size", "device", t.devicePath, "error", err)
		return
	}

	if !t.observed {
		t.observed = true
		t.log.InfoContext(ctx, "Data disk device observed", "device", t.devicePath, "deviceBytes", devBytes, "deviceGiB", devBytes>>30)
	}

	if t.unchanged(devBytes) {
		return
	}

	if err := t.runResize(ctx, t.devicePath); err != nil {
		t.failures++
		t.log.WarnContext(ctx, "Failed to resize data disk filesystem; will retry next round", "event", "runner.disk.resize", "device", t.devicePath, "deviceBytes", devBytes, "failures", t.failures, "error", err)
		return
	}

	bytes := devBytes
	t.lastDevBytes = &bytes

	t.log.InfoContext(ctx, "Data disk filesystem resized", "event", "runner.disk.resize", "device", t.devicePath, "deviceBytes", devBytes)
}

// unchanged reports whether the observed size equals the stored baseline, so
// the round can be skipped without running resize2fs.
func (t *Ticker) unchanged(devBytes uint64) bool {
	return t.lastDevBytes != nil && *t.lastDevBytes == devBytes
}

// logOnceMissing emits the missing-device debug line only once per process:
// AWS and local runners never have the device, so per-tick logging would only
// repeat the same fact every interval.
func (t *Ticker) logOnceMissing(ctx context.Context) {
	if t.missingLogged {
		return
	}
	t.missingLogged = true
	t.log.DebugContext(ctx, "Data disk device not found; disk resize is disabled on this host", "device", t.devicePath)
}
