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

	"github.com/shirou/gopsutil/v4/process"
)

func readMemory(ctx context.Context, box Box) (uint64, error) {
	if box.PID <= 0 {
		return 0, fmt.Errorf("box has no running PID")
	}
	if runtime.GOOS == "linux" {
		return readCgroupMemory("/proc", "/sys/fs/cgroup", box)
	}
	p, err := process.NewProcessWithContext(ctx, int32(box.PID))
	if err != nil {
		return 0, err
	}
	created, err := p.CreateTimeWithContext(ctx)
	if err != nil {
		return 0, err
	}
	usage, err := p.MemoryInfoWithContext(ctx)
	if err != nil {
		return 0, err
	}
	// Use a fresh reader because gopsutil caches creation time on the object.
	current, err := process.NewProcessWithContext(ctx, int32(box.PID))
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
