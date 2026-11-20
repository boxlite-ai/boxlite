// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

//go:build !linux

package healthcheck

import (
	"fmt"
	"runtime"
)

// verifyHomeOnDataDisk always fails off Linux: the GCP data disk and its
// stable device path exist only on the Linux runner hosts, and a host that
// cannot verify that the data disk carries its home must not advertise the
// disk identity. Desktop builds exercise the gate through injected hooks in
// the contract tests.
func verifyHomeOnDataDisk(homeDir, devicePath string) error {
	return fmt.Errorf("cannot verify the data disk carries the home on %s; not advertising the disk identity", runtime.GOOS)
}
