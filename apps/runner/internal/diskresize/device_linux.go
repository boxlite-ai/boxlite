// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

//go:build linux

package diskresize

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

// sysfsSizeUnitBytes is the reporting unit of /sys/dev/block/M:m/size. The
// block core stores every block device's capacity as a count of 512-byte
// sectors (bdev_nr_sectors in block/bdev.c), and drivers convert to this unit
// when registering the device — so it holds for local NVMe, virtio, and
// remote disks (NBD, iSCSI, RBD) alike. Do NOT substitute
// queue/logical_block_size: hyperdisk presents 4 KiB logical sectors, and
// scaling the sector count by it would overestimate capacity 8x.
const sysfsSizeUnitBytes = 512

// defaultReadDeviceSize resolves the data disk device and reads its capacity.
// The by-id symlink is followed to the real device node; the size comes from
// sysfs (512-byte sector count), not from statfs, because the trigger is the
// device getting larger — not the filesystem's view of its own size.
func defaultReadDeviceSize(ctx context.Context, devicePath string) (uint64, error) {
	fi, err := os.Stat(devicePath)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, fmt.Errorf("%w: %s", ErrDeviceMissing, devicePath)
		}
		return 0, fmt.Errorf("stat %s: %w", devicePath, err)
	}
	if fi.Mode()&os.ModeDevice == 0 || fi.Mode()&os.ModeCharDevice != 0 {
		return 0, fmt.Errorf("%s is not a block device", devicePath)
	}

	sys, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, fmt.Errorf("stat %s: unsupported stat type %T", devicePath, fi.Sys())
	}

	// Linux device number encoding (include/linux/kdev_t.h new_encode_dev):
	// major = (rdev >> 8) & 0xfff | ((rdev >> 32) & ~0xfff)
	// minor = (rdev & 0xff) | ((rdev >> 12) & ~0xff)
	rdev := uint64(sys.Rdev)
	major := ((rdev >> 8) & 0xfff) | ((rdev >> 32) & ^uint64(0xfff))
	minor := (rdev & 0xff) | ((rdev >> 12) & ^uint64(0xff))

	sysfsPath := fmt.Sprintf("/sys/dev/block/%d:%d/size", major, minor)
	raw, err := os.ReadFile(sysfsPath)
	if err != nil {
		return 0, fmt.Errorf("read %s: %w", sysfsPath, err)
	}

	sectors, err := strconv.ParseUint(strings.TrimSpace(string(raw)), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("parse %s: %w", sysfsPath, err)
	}

	return sectors * sysfsSizeUnitBytes, nil
}

// defaultRunResize executes resize2fs on the device. On a mounted ext4
// filesystem this grows the fs online; a no-op on an unchanged fs still exits
// 0 ("Nothing to do!"), which the ticker treats as success.
func defaultRunResize(ctx context.Context, devicePath string) error {
	cmd := exec.CommandContext(ctx, "resize2fs", devicePath)
	output, err := cmd.CombinedOutput()
	if err == nil {
		return nil
	}
	// Keep the tail of resize2fs's own output: it names the actual failure
	// (superblock hints, read-only fs, ...) and the log line must stay short.
	out := string(output)
	if len(out) > 256 {
		out = out[len(out)-256:]
	}
	return fmt.Errorf("resize2fs %s: %w: %s", devicePath, err, out)
}
