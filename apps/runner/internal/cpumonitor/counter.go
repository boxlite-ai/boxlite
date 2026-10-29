// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package cpumonitor

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"

	"github.com/shirou/gopsutil/v4/process"
)

func readCounter(ctx context.Context, box Box) (counter, error) {
	if box.PID <= 0 {
		return counter{}, fmt.Errorf("box has no running PID")
	}
	if runtime.GOOS == "linux" {
		return readCgroupCounter("/proc", "/sys/fs/cgroup", box)
	}
	// A fresh reader avoids gopsutil's cached process creation time on PID reuse.
	p, err := process.NewProcessWithContext(ctx, int32(box.PID))
	if err != nil {
		return counter{}, err
	}
	created, err := p.CreateTimeWithContext(ctx)
	if err != nil {
		return counter{}, err
	}
	times, err := p.TimesWithContext(ctx)
	if err != nil {
		return counter{}, err
	}
	return counter{identity: fmt.Sprintf("%d:%d", box.PID, created), seconds: times.User + times.System}, nil
}

func readCgroupCounter(procRoot, cgroupRoot string, box Box) (counter, error) {
	membership, err := os.ReadFile(filepath.Join(procRoot, strconv.Itoa(box.PID), "cgroup"))
	if err != nil {
		return counter{}, err
	}
	for _, line := range strings.Split(string(membership), "\n") {
		path, unified := strings.CutPrefix(line, "0::")
		if !unified {
			continue
		}
		// A failed jailer join must never attribute the host/runner parent group
		// to a box. Validate before constructing a filesystem path.
		if !filepath.IsAbs(path) || filepath.Clean(path) != path || filepath.Base(path) != box.RuntimeID || filepath.Base(filepath.Dir(path)) != "boxlite" {
			return counter{}, fmt.Errorf("PID cgroup does not match runtime box")
		}
		file, err := os.Open(filepath.Join(cgroupRoot, strings.TrimPrefix(path, "/"), "cpu.stat"))
		if err != nil {
			return counter{}, err
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil {
			return counter{}, err
		}
		body, err := io.ReadAll(io.LimitReader(file, 4096))
		if err != nil {
			return counter{}, err
		}
		for _, statLine := range strings.Split(string(body), "\n") {
			fields := strings.Fields(statLine)
			if len(fields) != 2 || fields[0] != "usage_usec" {
				continue
			}
			micros, err := strconv.ParseUint(fields[1], 10, 64)
			if err != nil {
				return counter{}, err
			}
			stat := info.Sys().(*syscall.Stat_t)
			return counter{identity: fmt.Sprintf("%d:%d:%s", stat.Dev, stat.Ino, box.StartedAt), seconds: float64(micros) / 1e6}, nil
		}
		return counter{}, fmt.Errorf("cgroup CPU usage counter missing")
	}
	return counter{}, fmt.Errorf("unified box cgroup missing")
}
