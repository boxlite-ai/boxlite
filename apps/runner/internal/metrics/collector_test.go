// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package metrics

import (
	"context"
	sdkboxlite "github.com/boxlite-ai/boxlite/sdks/go"
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

type allocationReaderFixture struct {
	infos   []sdkboxlite.BoxInfo
	reads   int
	sampled chan struct{}
}

func (r *allocationReaderFixture) ListInfo(context.Context) ([]sdkboxlite.BoxInfo, error) {
	r.reads++
	if r.reads == 2 {
		close(r.sampled)
	}
	return r.infos, nil
}
func (r *allocationReaderFixture) Metrics(context.Context) (*sdkboxlite.RuntimeMetrics, error) {
	return &sdkboxlite.RuntimeMetrics{}, nil
}

func allocationCollectorForTest(t *testing.T, reader *allocationReaderFixture) *Collector {
	t.Helper()
	return &Collector{boxlite: reader, log: quietLogger(), allocatedResourcesSnapshotInterval: time.Millisecond}
}

func TestCheckpointPausedAllocationUsesReservedResources(t *testing.T) {
	for _, paused := range []bool{true, false} {
		t.Run(map[bool]string{true: "paused retains reservation", false: "stopped releases reservation"}[paused], func(t *testing.T) {
			state := sdkboxlite.State("stopped")
			if paused {
				state = "paused"
			}
			reader := &allocationReaderFixture{sampled: make(chan struct{}), infos: []sdkboxlite.BoxInfo{{State: "running", Running: true, CPUs: 2, MemoryMiB: 1024}, {State: state, Running: false, CPUs: 4, MemoryMiB: 2048}, {State: "stopped", CPUs: 8, MemoryMiB: 4096}}}
			collector := allocationCollectorForTest(t, reader)
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan struct{})
			go func() { defer close(done); collector.snapshotAllocatedResources(ctx) }()
			defer func() { cancel(); <-done }()
			select {
			case <-reader.sampled:
			case <-time.After(3 * time.Second):
				t.Fatal("allocation sampler never read production input")
			}
			collector.resourcesMutex.RLock()
			cpu, mem, started := collector.allocatedCPU, collector.allocatedMemoryGiB, collector.startedBoxCount
			collector.resourcesMutex.RUnlock()
			wantCPU, wantMem := float32(2), float32(1)
			if paused {
				wantCPU = 6
				wantMem = 3
			}
			if cpu != wantCPU || mem != wantMem || started != 1 {
				t.Fatalf("sampled cpu=%v mem=%v started=%v; want %v %v 1", cpu, mem, started, wantCPU, wantMem)
			}
		})
	}
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
