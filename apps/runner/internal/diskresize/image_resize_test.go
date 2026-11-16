// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

// Linux-only integration tests for the filesystem-follows step of the disk
// expansion chain, running over a plain image file instead of a block device.
// e2fsprogs treats a regular file holding an ext4 filesystem the same way it
// treats a device, so the growth behavior the production wrapper exercises
// (defaultRunResize invoking resize2fs) is provable on any unprivileged Linux
// host.
//
// Off Linux these tests skip with a warning: the code under test is
// Linux-only by design — device_other.go stubs both boundaries to
// ErrDeviceMissing off Linux, because the data disk is a GCP runner-host
// concept and desktop hosts never enable disk expansion. Desktop coverage
// stays with the platform-neutral unit tests in ticker_test.go.
//
// What this layer deliberately does not cover: the kernel block layer (sysfs
// capacity reads, mounted online resize, the ticker loop). Those stay in
// loop_integration_test.go; the two files together cover the chain, each
// documenting its own half.
//
// Tools come from e2fsprogs, present on any normal Linux image. A missing
// toolset skips with the install hint rather than failing.

package diskresize

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

// requireLinuxHost skips the test with a warning off Linux. The disk
// expansion chain under test — the GCP data disk device, sysfs capacity
// reads, and resize2fs — exists only on the Linux runner hosts; off Linux the
// production boundaries are stubs (device_other.go), so there is nothing real
// to exercise.
func requireLinuxHost(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skipf("WARNING: disk-expansion integration test only runs on Linux, host is %s; skipping", runtime.GOOS)
	}
}

// extToolDirs lists the Homebrew prefixes mkfs.ext4/resize2fs/dumpe2fs hide
// behind on macOS: Homebrew keeps sbin out of PATH, and the formula installs
// there.
var extToolDirs = []string{
	"/opt/homebrew/opt/e2fsprogs/sbin",
	"/usr/local/opt/e2fsprogs/sbin",
}

// expansionTestInitialMiB and expansionTestGrownMiB leave a 50% growth step
// between the two sizes, well above ext4's minimum fs size (~3 MiB) on both
// ends. Shared by the file-image layer and the Linux loop-device layer.
const (
	expansionTestInitialMiB = 64
	expansionTestGrownMiB   = 96
)

// findTool resolves one e2fsprogs binary: from PATH first, then from the
// Homebrew sbin dirs.
func findTool(t *testing.T, name string) string {
	t.Helper()

	if path, err := exec.LookPath(name); err == nil {
		return path
	}
	for _, dir := range extToolDirs {
		path := filepath.Join(dir, name)
		if _, err := os.Stat(path); err == nil {
			return path
		}
	}
	t.Skipf("integration test needs %s (install e2fsprogs: apt-get install e2fsprogs / brew install e2fsprogs); skipping", name)
	return ""
}

// newFileImage creates a sparse file of `sizeMiB` and formats it ext4.
func newFileImage(t *testing.T, sizeMiB int64) string {
	t.Helper()

	mkfs := findTool(t, "mkfs.ext4")
	file := filepath.Join(t.TempDir(), "data-disk.img")
	f, err := os.Create(file)
	if err != nil {
		t.Fatalf("create image file: %v", err)
	}
	if err := f.Truncate(sizeMiB << 20); err != nil {
		f.Close()
		t.Fatalf("truncate image to %dMiB: %v", sizeMiB, err)
	}
	f.Close()

	// -F forces formatting over a plain file instead of prompting; the same
	// flag the loop-device fixture uses for loop devices.
	out, err := exec.Command(mkfs, "-q", "-F", file).CombinedOutput()
	if err != nil {
		t.Fatalf("mkfs.ext4 %s: %v: %s", file, err, strings.TrimSpace(string(out)))
	}
	return file
}

// growImage enlarges the image file — the effect a cloud disk resize has on
// the storage backing the filesystem.
func growImage(t *testing.T, file string, sizeMiB int64) {
	t.Helper()

	f, err := os.OpenFile(file, os.O_WRONLY, 0)
	if err != nil {
		t.Fatalf("open image for growth: %v", err)
	}
	if err := f.Truncate(sizeMiB << 20); err != nil {
		f.Close()
		t.Fatalf("truncate image to %dMiB: %v", sizeMiB, err)
	}
	f.Close()
}

// After the backing storage grows, resize2fs invoked through the production
// wrapper grows the filesystem into the new space — the fs-follows half of
// the expansion chain, proven here over a plain file so macOS and any Linux
// box without privileges can run it.
func TestResize2fsGrowsFileImageOnTruncation(t *testing.T) {
	requireLinuxHost(t)
	// findTool here only gates the run: defaultRunResize resolves its own
	// resize2fs, so the variable itself has no further use.
	findTool(t, "resize2fs")
	dumpe2fs := findTool(t, "dumpe2fs")
	image := newFileImage(t, expansionTestInitialMiB)

	before := dumpe2fsImageBytes(t, dumpe2fs, image)

	growImage(t, image, expansionTestGrownMiB)
	if err := defaultRunResize(context.Background(), image); err != nil {
		t.Fatalf("resize2fs after growth: %v", err)
	}

	after := dumpe2fsImageBytes(t, dumpe2fs, image)
	if after <= before {
		t.Fatalf("filesystem capacity did not grow: before=%d after=%d", before, after)
	}
}

// dumpe2fsImageBytes parses the superblock's block count times block size off
// an ext4 image — file or device, dumpe2fs accepts both. The explicit tool
// path comes from findTool so macOS's Homebrew sbin resolves here too.
func dumpe2fsImageBytes(t *testing.T, dumpe2fsPath, target string) uint64 {
	t.Helper()

	out, err := exec.Command(dumpe2fsPath, "-h", target).CombinedOutput()
	if err != nil {
		t.Fatalf("dumpe2fs -h %s: %v: %s", target, err, strings.TrimSpace(string(out)))
	}
	var blockCount, blockSize uint64
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if value, found := strings.CutPrefix(line, "Block count:"); found {
			blockCount = parseLeadingUint(t, line, value)
		}
		if value, found := strings.CutPrefix(line, "Block size:"); found {
			blockSize = parseLeadingUint(t, line, value)
		}
	}
	if blockCount == 0 || blockSize == 0 {
		t.Fatalf("dumpe2fs -h %s: superblock lacks Block count/Block size:\n%s", target, string(out))
	}
	return blockCount * blockSize
}

func parseLeadingUint(t *testing.T, line, value string) uint64 {
	t.Helper()
	n, err := strconv.ParseUint(strings.TrimSpace(value), 10, 64)
	if err != nil {
		t.Fatalf("parse %q: %v", line, err)
	}
	return n
}

// defaultRunResize must surface resize2fs failures instead of swallowing
// them: a missing or non-filesystem image makes resize2fs exit non-zero, and
// the ticker relies on that error to schedule its retry.
func TestRunResizeSurfacesResize2fsFailure(t *testing.T) {
	requireLinuxHost(t)
	findTool(t, "resize2fs")

	missing := filepath.Join(t.TempDir(), "no-such.img")
	if err := defaultRunResize(context.Background(), missing); err == nil {
		t.Fatalf("resize2fs on a missing image succeeded; the ticker would treat it as a completed resize")
	}
}
