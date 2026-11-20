// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

//go:build linux

package healthcheck

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The Linux backing check against real stats: a directory the device does not
// carry must mismatch, and an absent device must read as such. A matching
// pair cannot be fabricated without a real block device, so the pass path
// stays with the host-level coverage (contract tests inject the hook).
func TestVerifyDataDiskBackingDetectsMismatch(t *testing.T) {
	home := t.TempDir()

	if err := verifyDataDiskBacking(home, filepath.Join(home, "absent-device")); err == nil {
		t.Fatalf("absent device passed the backing check")
	}
	if err := verifyDataDiskBacking(home, "/dev/null"); err == nil {
		t.Fatalf("home on the root filesystem passed the backing check against /dev/null")
	}
	err := verifyDataDiskBacking(home, "/dev/null")
	if !errors.Is(err, os.ErrNotExist) && !strings.Contains(err.Error(), "is not carried by") {
		t.Fatalf("unexpected error shape: %v", err)
	}
}
