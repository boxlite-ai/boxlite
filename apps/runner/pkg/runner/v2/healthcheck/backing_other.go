// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

//go:build !linux

package healthcheck

import (
	"fmt"
	"runtime"
)

// verifyDataDiskBacking always fails off Linux: the GCP data disk and its
// stable device path exist only on the Linux runner hosts, and a host that
// cannot verify backing must not advertise an expandable disk. Desktop
// coverage stays with the contract tests, which inject their own hook.
func verifyDataDiskBacking(homeDir, devicePath string) error {
	return fmt.Errorf("data disk backing cannot be verified on %s; not advertising the identity", runtime.GOOS)
}
