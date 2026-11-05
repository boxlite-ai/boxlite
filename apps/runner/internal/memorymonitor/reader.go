// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package memorymonitor

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v4/process"
)

var readMemory = newMemoryReader("/proc", "/sys/fs/cgroup")

func newMemoryReader(procRoot, cgroupRoot string) func(context.Context, Box) (uint64, error) {
	// A canceled caller leaves at most one kernel read in flight. Keep its slot
	// until the read finishes so repeated timeouts cannot accumulate workers.
	slot := make(chan struct{}, 1)
	return func(ctx context.Context, box Box) (uint64, error) {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		if box.PID <= 0 {
			return 0, fmt.Errorf("box has no running PID")
		}
		if runtime.GOOS != "linux" {
			return readProcessMemory(ctx, box.PID, box.StartedAt)
		}
		select {
		case slot <- struct{}{}:
		case <-ctx.Done():
			return 0, ctx.Err()
		}
		type result struct {
			bytes uint64
			err   error
		}
		done := make(chan result, 1)
		go func() {
			defer func() { <-slot }()
			bytes, err := readCgroupMemory(procRoot, cgroupRoot, box)
			done <- result{bytes: bytes, err: err}
		}()
		select {
		case value := <-done:
			return value.bytes, value.err
		case <-ctx.Done():
			return 0, ctx.Err()
		}
	}
}

func readProcessMemory(ctx context.Context, pid int, startedAt time.Time) (uint64, error) {
	p, err := process.NewProcessWithContext(ctx, int32(pid))
	if err != nil {
		return 0, err
	}
	created, err := p.CreateTimeWithContext(ctx)
	if err != nil {
		return 0, err
	}
	// A replacement PID may already exist before the first lookup.
	if startedAt.IsZero() || created > startedAt.UnixMilli() {
		return 0, fmt.Errorf("box process identity does not match start time")
	}
	usage, err := p.MemoryInfoWithContext(ctx)
	if err != nil {
		return 0, err
	}
	// Use a fresh reader because gopsutil caches creation time on the object.
	current, err := process.NewProcessWithContext(ctx, int32(pid))
	if err != nil {
		return 0, err
	}
	started, err := current.CreateTimeWithContext(ctx)
	if err != nil || started != created {
		return 0, fmt.Errorf("box process identity changed: %v", err)
	}
	return usage.RSS, nil
}

func readCgroupMemory(procRoot, cgroupRoot string, box Box) (uint64, error) {
	if box.PID <= 0 {
		return 0, fmt.Errorf("box has no running PID")
	}
	memberPath := filepath.Join(procRoot, strconv.Itoa(box.PID), "cgroup")
	membership, err := os.ReadFile(memberPath)
	if err != nil {
		return 0, err
	}
	for _, line := range strings.Split(string(membership), "\n") {
		path, unified := strings.CutPrefix(line, "0::")
		if !unified {
			continue
		}
		// Include the VM descendants, never an ancestor or a different Box.
		if !filepath.IsAbs(path) || filepath.Clean(path) != path || filepath.Base(path) != box.RuntimeID || filepath.Base(filepath.Dir(path)) != "boxlite" {
			return 0, fmt.Errorf("PID cgroup does not match runtime box")
		}
		body, err := os.ReadFile(filepath.Join(cgroupRoot, strings.TrimPrefix(path, "/"), "memory.current"))
		if err != nil {
			return 0, err
		}
		current, err := os.ReadFile(memberPath)
		if err != nil || string(current) != string(membership) {
			return 0, fmt.Errorf("box cgroup membership changed: %v", err)
		}
		return strconv.ParseUint(strings.TrimSpace(string(body)), 10, 63)
	}
	return 0, fmt.Errorf("unified box cgroup missing")
}
