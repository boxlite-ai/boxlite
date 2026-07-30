// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package rollout

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
)

// detachedShim is one box whose shim process outlived the runner that started
// it. Restarting the runner must not disturb these: the VM keeps running, and
// the new runner is expected to re-adopt it.
//
// startTime pins the identity of the process. A bare PID is not enough — PIDs
// are recycled, and a rollout that "verified" a recycled PID would report a
// healthy adoption of a box whose VM had actually died.
type detachedShim struct {
	boxID     string
	pid       int
	startTime string
}

// SnapshotDetachedShims records the live detached shims before the runner is
// stopped, so the same set can be checked afterwards.
func (h *Host) SnapshotDetachedShims() ([]detachedShim, error) {
	boxesDir := filepath.Join(h.env.homeDir, "boxes")
	entries, err := os.ReadDir(boxesDir)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	var shims []detachedShim
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		shim, ok := readShimPid(filepath.Join(boxesDir, entry.Name(), "shim.pid"), entry.Name())
		if !ok {
			continue
		}
		if !shim.alive() {
			continue
		}
		shims = append(shims, shim)
	}
	sort.Slice(shims, func(i, j int) bool { return shims[i].boxID < shims[j].boxID })
	return shims, nil
}

// VerifyAdoptedShims proves the new runner did not disturb the boxes that were
// running before it started, and that it can actually talk to them.
func (h *Host) VerifyAdoptedShims(ctx context.Context, before []detachedShim) error {
	for _, want := range before {
		now, ok := readShimPid(filepath.Join(h.env.homeDir, "boxes", want.boxID, "shim.pid"), want.boxID)
		if !ok {
			return fmt.Errorf("box %s: shim.pid unreadable after rollout", want.boxID)
		}
		if now.pid != want.pid {
			return fmt.Errorf("box %s: shim pid changed across rollout (before=%d after=%d)", want.boxID, want.pid, now.pid)
		}
		if !now.alive() {
			return fmt.Errorf("box %s: shim pid %d is not alive after rollout", want.boxID, now.pid)
		}
		if want.startTime != "" {
			if now.startTime != want.startTime {
				return fmt.Errorf("box %s: shim start-time changed across rollout", want.boxID)
			}
			if actual := procStartTime(now.pid); actual != want.startTime {
				return fmt.Errorf("box %s: shim pid %d failed start-time verification", want.boxID, now.pid)
			}
		}

		// Forces the new runner process through getOrFetchBox -> runtime.Get ->
		// vmm_attach for a box that existed only in the previous runner's
		// memory. Without this the rollout would pass while the first real
		// request against the box failed.
		if _, err := h.get(ctx, "/v1/boxes/"+want.boxID+"/metrics", true); err != nil {
			return fmt.Errorf("box %s: new runner failed to attach/probe it: %w", want.boxID, err)
		}
	}
	return nil
}

func readShimPid(path, boxID string) (detachedShim, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return detachedShim{}, false
	}
	lines := strings.Split(string(raw), "\n")
	if len(lines) == 0 {
		return detachedShim{}, false
	}

	pid := 0
	if _, err := fmt.Sscanf(strings.TrimSpace(lines[0]), "%d", &pid); err != nil || pid <= 0 {
		return detachedShim{}, false
	}
	shim := detachedShim{boxID: boxID, pid: pid}
	if len(lines) > 1 {
		shim.startTime = digitsOnly(lines[1])
	}
	return shim, true
}

func (s detachedShim) alive() bool {
	if s.pid <= 0 {
		return false
	}
	if err := syscall.Kill(s.pid, 0); err != nil {
		return false
	}
	// A zombie answers signal 0 but its VM is gone.
	if procState(s.pid) == "Z" {
		return false
	}
	if s.startTime != "" && procStartTime(s.pid) != s.startTime {
		return false
	}
	return true
}

func procStat(pid int) []string {
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return nil
	}
	return parseProcStat(string(raw))
}

// parseProcStat returns the fields of /proc/<pid>/stat from field 3 onwards.
//
// Fields cannot simply be split on whitespace: comm (field 2) is parenthesised
// and may itself contain spaces and parens — a shim exec'd from a path like
// "boxlite shim (v2)" would shift every later field. Everything up to the LAST
// ')' is therefore discarded first.
func parseProcStat(raw string) []string {
	end := strings.LastIndex(raw, ")")
	if end < 0 || end+2 > len(raw) {
		return nil
	}
	return strings.Fields(raw[end+2:])
}

// procState is field 3 — the first field after comm.
func procState(pid int) string {
	fields := procStat(pid)
	if len(fields) < 1 {
		return ""
	}
	return fields[0]
}

// procStartTime is field 22 — ticks since boot, which together with the PID
// identifies a process uniquely across recycling.
func procStartTime(pid int) string {
	fields := procStat(pid)
	if len(fields) < 20 {
		return ""
	}
	return fields[19]
}

func digitsOnly(s string) string {
	return strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, s)
}
