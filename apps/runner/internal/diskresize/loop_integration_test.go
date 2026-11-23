// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

//go:build linux

// Integration tests over a real loop device: the host-side disk expansion
// chain cannot be covered by the injected fakes in ticker_test.go, because its
// two real boundaries — reading capacity through sysfs and growing a mounted
// filesystem with resize2fs — are exactly what the fakes replace.
//
// A loop device backed by a sparse file stands in for the GCP NVMe data disk.
// The equivalence the tests rely on: diskresize's two boundaries see only the
// kernel block layer, and the kernel presents loop and NVMe devices to sysfs
// in the same shape (a 512-byte sector count under /sys/dev/block/M:m/size).
// What stays outside the loop: the platform step (GCP grows the disk resource
// and the host NVMe device follows) is a GCP promise verified once against a
// live stage, not here.
//
// Growing the backing file and refreshing the loop device (truncate +
// `losetup -c`) reproduces the effect the ticker waits for in production:
// the device size changing under a mounted filesystem, with no remount.
//
// Privileges: creating a loop device needs CAP_SYS_ADMIN, so both losetup and
// mount fail for an unprivileged user. Each test probes for the capability
// first and skips with the reason plus the local command to run it:
//
//	docker run --rm --privileged -v "$PWD":/w -w /w golang:1.24 \
//	  go test -tags boxlite_dev ./internal/diskresize/
//
// CI keeps the plain unprivileged `make test:apps:runner` and therefore skips
// these; wiring a privileged step in CI is deliberately out of scope here.
package diskresize

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// loopTestInterval keeps the closed-loop test's cadence far below the seconds
// the growth step itself takes, so a tick lands promptly after the device
// grows.
const loopTestInterval = 50 * time.Millisecond

// requireLoopTools probes the privileged toolset the loop tests need and
// returns a ready loop device, or skips the test with the missing piece named.
// Probing by actually creating the device matters: losetup can exist on PATH
// while the sandbox still denies CAP_SYS_ADMIN, and a mere version probe
// would then report a false-positive capability.
func requireLoopTools(t *testing.T) *loopDisk {
	t.Helper()

	for _, tool := range []string{"losetup", "mkfs.ext4", "resize2fs"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("integration test needs %s on PATH; skipping: %v", tool, err)
		}
	}

	disk, err := newLoopDisk(t, expansionTestInitialMiB)
	if err != nil {
		t.Skipf("cannot create a loop device (needs CAP_SYS_ADMIN); run under sudo or a privileged container. skipping: %v", err)
	}
	return disk
}

// loopDisk is a sparse-file-backed loop device whose backing file can grow.
type loopDisk struct {
	file   string
	device string
}

// newLoopDisk creates a sparse file of `sizeMiB`, attaches it as a loop
// device, and registers cleanup that detaches and removes it.
func newLoopDisk(t *testing.T, sizeMiB int64) (*loopDisk, error) {
	t.Helper()

	file := filepath.Join(t.TempDir(), "data-disk.img")
	f, err := os.Create(file)
	if err != nil {
		return nil, fmt.Errorf("create backing file: %w", err)
	}
	if err := f.Truncate(sizeMiB << 20); err != nil {
		f.Close()
		return nil, fmt.Errorf("truncate backing file to %dMiB: %w", sizeMiB, err)
	}
	f.Close()

	device, err := loopAttach(file)
	if err != nil {
		return nil, err
	}
	disk := &loopDisk{file: file, device: device}
	t.Cleanup(disk.detach)
	return disk, nil
}

// loopAttach finds a free loop device and binds the file to it.
func loopAttach(file string) (string, error) {
	out, err := exec.Command("losetup", "--find", "--show", file).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("losetup --find --show %s: %w: %s", file, err, strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out)), nil
}

// grow enlarges the backing file and refreshes the loop device so the kernel
// sees the new capacity — the same two-step effect a GCP online resize has on
// the host NVMe device: the backing store grows, then the kernel block layer
// updates the size the device reports through sysfs.
func (d *loopDisk) grow(t *testing.T, sizeMiB int64) {
	t.Helper()

	f, err := os.OpenFile(d.file, os.O_WRONLY, 0)
	if err != nil {
		t.Fatalf("open backing file for growth: %v", err)
	}
	if err := f.Truncate(sizeMiB << 20); err != nil {
		f.Close()
		t.Fatalf("truncate backing file to %dMiB: %v", sizeMiB, err)
	}
	f.Close()

	out, err := exec.Command("losetup", "-c", d.device).CombinedOutput()
	if err != nil {
		t.Fatalf("losetup -c %s: %v: %s", d.device, err, strings.TrimSpace(string(out)))
	}
}

// detach releases the loop device. Cleanup keeps working when attach itself
// failed midway: an empty device name makes losetup -d a no-op error that the
// test ignores.
func (d *loopDisk) detach() {
	if d.device == "" {
		return
	}
	_ = exec.Command("losetup", "-d", d.device).Run()
	_ = os.Remove(d.file)
}

// makeExt4 formats the device. -F forces over a loop device without an
// interactive prompt; -q keeps test output readable.
func (d *loopDisk) makeExt4(t *testing.T) {
	t.Helper()
	out, err := exec.Command("mkfs.ext4", "-q", "-F", d.device).CombinedOutput()
	if err != nil {
		t.Fatalf("mkfs.ext4 %s: %v: %s", d.device, err, strings.TrimSpace(string(out)))
	}
}

// --- capacity reading ---------------------------------------------------

// fsBytes reads the filesystem's own capacity. A mounted fs reports through
// statfs; an unmounted one through dumpe2fs's superblock view. Tests assert
// on this after resize2fs, so the check crosses from the fs superblock rather
// than from anything the test itself built.
func fsBytes(t *testing.T, device, mountDir string) uint64 {
	t.Helper()

	if mountDir != "" {
		var st syscall.Statfs_t
		if err := syscall.Statfs(mountDir, &st); err != nil {
			t.Fatalf("statfs %s: %v", mountDir, err)
		}
		return uint64(st.Blocks) * uint64(st.Bsize)
	}
	return dumpe2fsBytes(t, device)
}

// dumpe2fsBytes reads the superblock capacity of an unmounted ext4 device.
func dumpe2fsBytes(t *testing.T, device string) uint64 {
	t.Helper()
	return dumpe2fsImageBytes(t, findTool(t, "dumpe2fs"), device)
}

// tryMount mounts the device read-write and returns the mountpoint, or an
// empty string when the environment denies CAP_SYS_ADMIN: the unprivileged
// fallback then proves the offline path instead of the mounted one, and the
// caller says so in its log.
func tryMount(t *testing.T, device string) (string, func()) {
	t.Helper()

	dir := filepath.Join(t.TempDir(), "mnt")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatalf("mkdir mountpoint: %v", err)
	}
	if err := exec.Command("mount", device, dir).Run(); err != nil {
		t.Logf("mount failed (%v); verifying the offline resize path instead of the mounted one", err)
		return "", func() {}
	}
	return dir, func() {
		if err := exec.Command("umount", dir).Run(); err != nil {
			t.Errorf("umount %s: %v", dir, err)
		}
	}
}

// --- the tests ----------------------------------------------------------

// The device-capacity step of the expansion chain: after the backing store
// grows and the loop device refreshes, sysfs reports the new size and the
// production reader sees it — the host-kernel equivalent of a GCP NVMe device
// following a disk resize.
func TestLoopDeviceSizeTracksGrowth(t *testing.T) {
	disk := requireLoopTools(t)

	initial, err := defaultReadDeviceSize(context.Background(), disk.device)
	if err != nil {
		t.Fatalf("read initial device size: %v", err)
	}
	if initial != expansionTestInitialMiB<<20 {
		t.Fatalf("initial device size = %d bytes, want %dMiB", initial, expansionTestInitialMiB)
	}

	disk.grow(t, expansionTestGrownMiB)

	grown, err := defaultReadDeviceSize(context.Background(), disk.device)
	if err != nil {
		t.Fatalf("read grown device size: %v", err)
	}
	if grown != expansionTestGrownMiB<<20 {
		t.Fatalf("grown device size = %d bytes, want %dMiB", grown, expansionTestGrownMiB)
	}
}

// The filesystem-follows step: after the device grows, resize2fs grows a
// mounted ext4 online. Environments without mount privileges verify the same
// growth through resize2fs's offline path, which exercises the identical
// device-triggered invocation and the identical superblock change.
func TestResize2fsGrowsFilesystemOnGrownDevice(t *testing.T) {
	disk := requireLoopTools(t)
	disk.makeExt4(t)

	mountDir, umount := tryMount(t, disk.device)
	defer umount()
	online := mountDir != ""
	before := fsBytes(t, disk.device, mountDir)

	disk.grow(t, expansionTestGrownMiB)
	if err := defaultRunResize(context.Background(), disk.device); err != nil {
		t.Fatalf("resize2fs after growth: %v", err)
	}

	after := fsBytes(t, disk.device, mountDir)
	if after <= before {
		t.Fatalf("filesystem capacity did not grow: before=%d after=%d (online=%v)", before, after, online)
	}
	t.Logf("verified the %s path: fs capacity %d -> %d bytes",
		map[bool]string{true: "mounted/online", false: "offline"}[online], before, after)
}

// The closed loop: with the production defaults wired in (real sysfs reader,
// real resize2fs), the ticker notices the device growth and grows the fs on
// its own within a few ticks — no test-provided resize call. This is the
// end-to-end behavior the runner process relies on: disk grew, fs followed,
// nothing else involved.
func TestTickerClosesTheLoop(t *testing.T) {
	disk := requireLoopTools(t)
	disk.makeExt4(t)

	// Baseline: the first tick runs resize2fs once against the unchanged fs
	// (nil baseline), then settles. Give it time for the no-op resize pass.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ticker := New(Config{
		Logger:     slog.New(slog.DiscardHandler),
		Interval:   loopTestInterval,
		DevicePath: disk.device,
	})
	before := dumpe2fsBytes(t, disk.device)
	done := make(chan struct{})
	go func() {
		ticker.Run(ctx)
		close(done)
	}()

	// Let two steady-state ticks pass, then grow the device the way the
	// cloud disk grows: backing store first, kernel refresh second.
	time.Sleep(3 * loopTestInterval)
	disk.grow(t, expansionTestGrownMiB)

	// The ticker should pick up the new size on its next round and resize.
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if dumpe2fsBytes(t, disk.device) > before {
			cancel()
			<-done
			return
		}
		time.Sleep(loopTestInterval)
	}
	cancel()
	<-done
	t.Fatalf("ticker never grew the filesystem: fs stayed at %d bytes for 10s after the device grew to %dMiB",
		before, expansionTestGrownMiB)
}

// A regular file is not a block device: the production reader must reject it
// rather than read capacity out of its stat.
func TestNonBlockDeviceIsRejected(t *testing.T) {
	file := filepath.Join(t.TempDir(), "plain-file")
	if err := os.WriteFile(file, []byte("not a block device"), 0o644); err != nil {
		t.Fatalf("write plain file: %v", err)
	}

	_, err := defaultReadDeviceSize(context.Background(), file)
	if err == nil || !strings.Contains(err.Error(), "is not a block device") {
		t.Fatalf("plain file error = %v, want an 'is not a block device' failure", err)
	}
}

// After the loop device detaches, its path stops existing: the production
// reader must classify that as the permanent ErrDeviceMissing the ticker
// treats as a skip, not as a transient failure.
func TestMissingDeviceMapsToErrDeviceMissing(t *testing.T) {
	disk := requireLoopTools(t)
	device := disk.device
	disk.detach()

	_, err := defaultReadDeviceSize(context.Background(), device)
	if !errors.Is(err, ErrDeviceMissing) {
		t.Fatalf("detached device error = %v, want ErrDeviceMissing", err)
	}
}
