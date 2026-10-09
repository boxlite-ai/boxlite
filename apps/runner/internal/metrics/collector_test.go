// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package metrics

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

const bytesPerGiB = 1 << 30

// newTestCollector builds a collector whose disk metrics describe home, with one
// CPU sample already taken: collect() refuses to report before the first one.
func newTestCollector(home string) *Collector {
	c := NewCollector(CollectorConfig{
		Logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		BoxliteHomeDir: home,
		WindowSize:     1,
	})
	c.cpuRing.Value = CPUSnapshot{timestamp: time.Now(), cpuPercent: 1}
	return c
}

func statfs(t *testing.T, path string) syscall.Statfs_t {
	t.Helper()
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		t.Fatalf("statfs %s: %v", path, err)
	}
	return st
}

// homeOnSeparateFilesystem returns a directory on a filesystem other than the
// one mounted at /, so a collector still measuring / reports different numbers.
func homeOnSeparateFilesystem(t *testing.T) string {
	t.Helper()
	home, err := os.MkdirTemp("/dev/shm", "boxlite-home-")
	if err != nil {
		t.Skipf("no tmpfs at /dev/shm: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(home) })

	var homeStat, rootStat syscall.Stat_t
	if err := syscall.Stat(home, &homeStat); err != nil {
		t.Fatalf("stat %s: %v", home, err)
	}
	if err := syscall.Stat("/", &rootStat); err != nil {
		t.Fatalf("stat /: %v", err)
	}
	homeFS, rootFS := statfs(t, home), statfs(t, "/")
	if homeStat.Dev == rootStat.Dev ||
		homeFS.Blocks*uint64(homeFS.Bsize) == rootFS.Blocks*uint64(rootFS.Bsize) {
		t.Skip("/dev/shm cannot be told apart from the root filesystem")
	}
	return home
}

func usedGiB(st syscall.Statfs_t) float32 {
	return float32((st.Blocks-st.Bfree)*uint64(st.Bsize)) / bytesPerGiB
}

func TestCollectReportsTheBoxliteHomeFilesystem(t *testing.T) {
	home := homeOnSeparateFilesystem(t)
	// Data on the home's filesystem keeps its used space above zero.
	if err := os.WriteFile(filepath.Join(home, "disk.qcow2"), make([]byte, 8<<20), 0o600); err != nil {
		t.Fatalf("write data: %v", err)
	}

	before := statfs(t, home)
	got, err := newTestCollector(home).collect(context.Background())
	if err != nil {
		t.Fatalf("collect() error = %v", err)
	}
	after := statfs(t, home)

	wantTotal := float32(before.Blocks*uint64(before.Bsize)) / bytesPerGiB
	if got.TotalDiskGiB != wantTotal {
		t.Fatalf("TotalDiskGiB = %v, want %v (the filesystem holding %s)", got.TotalDiskGiB, wantTotal, home)
	}
	low, high := min(usedGiB(before), usedGiB(after)), max(usedGiB(before), usedGiB(after))
	if got.AllocatedDiskGiB < low || got.AllocatedDiskGiB > high {
		t.Fatalf("AllocatedDiskGiB = %v, want the used space of %s, between %v and %v",
			got.AllocatedDiskGiB, home, low, high)
	}
}

func TestCollectRejectsAZeroCapacityHome(t *testing.T) {
	// procfs reports no blocks; a zero capacity would reach the API as diskGiB 0.
	if _, err := os.Stat("/proc"); err != nil {
		t.Skipf("no /proc: %v", err)
	}
	if statfs(t, "/proc").Blocks != 0 {
		t.Skip("/proc reports blocks on this kernel")
	}
	if _, err := newTestCollector("/proc").collect(context.Background()); err == nil {
		t.Fatal("collect() succeeded for a zero-capacity home")
	}
}
