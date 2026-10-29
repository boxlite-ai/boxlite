// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package metrics

import (
	"bytes"
	"container/ring"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"strings"
	"testing"
	"testing/synctest"
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

func TestRunnerResourceLogUsesRecentCPUAndHomeDisk(t *testing.T) {
	var askedPath string
	c := newTestCollector("/boxlite-home", disk.UsageStat{Total: 400 * bytesPerGiB, Used: 100 * bytesPerGiB, UsedPercent: 25}, &askedPath)
	var logs bytes.Buffer
	c.log = slog.New(slog.NewJSONHandler(&logs, nil))
	now := time.Now()
	c.cpuRing = ring.New(3)
	for _, sample := range []CPUSnapshot{{now.Add(-61 * time.Second), 100}, {now.Add(-30 * time.Second), 40}, {now.Add(-5 * time.Second), 80}} {
		c.cpuRing.Value = sample
		c.cpuRing = c.cpuRing.Next()
	}
	c.logResourceSnapshot(context.Background(), now)
	var entry map[string]any
	if err := json.Unmarshal(logs.Bytes(), &entry); err != nil {
		t.Fatal(err)
	}
	if entry["event"] != "runner.resource.usage" || entry["cpuPercent"] != float64(60) || entry["diskPercent"] != float64(25) || entry["diskUsedGiB"] != float64(100) || entry["diskTotalGiB"] != float64(400) || askedPath != "/boxlite-home" {
		t.Fatalf("incorrect resource log: %v, path=%s", entry, askedPath)
	}
	if percent, ok := entry["memoryPercent"].(float64); !ok || percent < 0 || percent > 100 {
		t.Fatalf("invalid memory percentage: %v", entry)
	}
	logs.Reset()
	c.logResourceSnapshot(context.Background(), now.Add(2*time.Minute))
	if strings.Contains(logs.String(), "runner.resource.usage") || !strings.Contains(logs.String(), "Failed to collect recent CPU") {
		t.Fatal("reported stale CPU as current resource usage")
	}
}

func TestRunnerResourceLogMinuteCadenceAndShutdown(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var path string
		c := newTestCollector("/home", disk.UsageStat{Total: bytesPerGiB}, &path)
		var logs bytes.Buffer
		c.log = slog.New(slog.NewJSONHandler(&logs, nil))
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() { defer close(done); c.logResourceUsage(ctx) }()
		synctest.Wait()
		time.Sleep(59 * time.Second)
		if logs.Len() != 0 {
			t.Fatal("resource log ran before a minute")
		}
		c.cpuMutex.Lock()
		c.cpuRing.Value = CPUSnapshot{time.Now(), 50}
		c.cpuMutex.Unlock()
		time.Sleep(time.Second)
		synctest.Wait()
		if strings.Count(logs.String(), "runner.resource.usage") != 1 {
			t.Fatalf("expected one minute log: %s", logs.String())
		}
		cancel()
		<-done
	})
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
