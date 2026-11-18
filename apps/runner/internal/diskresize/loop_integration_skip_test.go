// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

//go:build !linux

// Off-Linux companions for loop_integration_test.go. That file carries
// //go:build tag and would otherwise vanish from `go test -list` and from the
// skip output on desktop hosts; this file keeps the same five test names
// visible everywhere, each skipping with the reason: the loop device, sysfs
// capacity reads, and mounted resize2fs only exist under a Linux kernel. The
// data disk is a GCP runner-host concept — desktop hosts never enable disk
// expansion — so there is nothing real to exercise here; desktop coverage
// stays with the platform-neutral unit tests in ticker_test.go.
package diskresize

import (
	"runtime"
	"testing"
)

func TestLoopDeviceSizeTracksGrowth(t *testing.T) {
	t.Skipf("WARNING: disk-expansion integration test only runs on Linux, host is %s; skipping", runtime.GOOS)
}

func TestResize2fsGrowsFilesystemOnGrownDevice(t *testing.T) {
	t.Skipf("WARNING: disk-expansion integration test only runs on Linux, host is %s; skipping", runtime.GOOS)
}

func TestTickerClosesTheLoop(t *testing.T) {
	t.Skipf("WARNING: disk-expansion integration test only runs on Linux, host is %s; skipping", runtime.GOOS)
}

func TestNonBlockDeviceIsRejected(t *testing.T) {
	t.Skipf("WARNING: disk-expansion integration test only runs on Linux, host is %s; skipping", runtime.GOOS)
}

func TestMissingDeviceMapsToErrDeviceMissing(t *testing.T) {
	t.Skipf("WARNING: disk-expansion integration test only runs on Linux, host is %s; skipping", runtime.GOOS)
}
