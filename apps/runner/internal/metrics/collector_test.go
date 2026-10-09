// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package metrics

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/shirou/gopsutil/v4/disk"
)

const bytesPerGiB = 1 << 30

// newTestCollector builds a collector for home with one CPU sample already
// taken, since collect() refuses to report before the first one. Its disk usage
// comes from usage, which records the path it was asked about.
func newTestCollector(home string, usage disk.UsageStat, askedPath *string) *Collector {
	c := NewCollector(CollectorConfig{
		Logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		BoxliteHomeDir: home,
		WindowSize:     1,
	})
	c.diskUsage = func(_ context.Context, path string) (*disk.UsageStat, error) {
		*askedPath = path
		return &usage, nil
	}
	c.cpuRing.Value = CPUSnapshot{timestamp: time.Now(), cpuPercent: 1}
	return c
}

func TestCollectReportsTheBoxliteHomeFilesystem(t *testing.T) {
	const home = "/var/lib/boxlite"
	usage := disk.UsageStat{Total: 400 * bytesPerGiB, Used: 100 * bytesPerGiB, UsedPercent: 25}
	var askedPath string

	got, err := newTestCollector(home, usage, &askedPath).collect(context.Background())
	if err != nil {
		t.Fatalf("collect() error = %v", err)
	}

	if got.TotalDiskGiB != 400 || got.AllocatedDiskGiB != 100 || got.DiskUsagePercentage != 25 {
		t.Fatalf("disk metrics = total %v GiB, used %v GiB, %v%%; want 400 GiB, 100 GiB, 25%% from the BoxLite home",
			got.TotalDiskGiB, got.AllocatedDiskGiB, got.DiskUsagePercentage)
	}
	if askedPath != home {
		t.Fatalf("disk usage was read for %q, want the BoxLite home %q", askedPath, home)
	}
}

func TestCollectRejectsAZeroCapacityHome(t *testing.T) {
	var askedPath string

	_, err := newTestCollector("/var/lib/boxlite", disk.UsageStat{}, &askedPath).collect(context.Background())
	if err == nil || !strings.Contains(err.Error(), "reports zero capacity") {
		t.Fatalf("collect() error = %v, want a zero-capacity rejection", err)
	}
}
