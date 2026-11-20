// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

//go:build linux

package healthcheck

import (
	"fmt"
	"syscall"
)

// verifyDataDiskBacking verifies that the filesystem holding homeDir is the
// one the device at devicePath carries: both stats must succeed, and the home
// filesystem's device number must equal the device node's own. The infra boot
// script formats the data disk whole — no partition table — so the exact
// device-number equality is the precise condition, and a partition-backed
// home would read as a mismatch. That is the fail-safe direction: expansion
// is withheld, not misattributed.
func verifyDataDiskBacking(homeDir, devicePath string) error {
	var home, dev syscall.Stat_t
	if err := syscall.Stat(homeDir, &home); err != nil {
		return fmt.Errorf("stat home %s: %w", homeDir, err)
	}
	if err := syscall.Stat(devicePath, &dev); err != nil {
		return fmt.Errorf("stat %s: %w", devicePath, err)
	}
	if home.Dev != dev.Rdev {
		return fmt.Errorf(
			"filesystem holding %s (device %d) is not carried by %s (device %d)",
			homeDir, home.Dev, devicePath, dev.Rdev,
		)
	}
	return nil
}
