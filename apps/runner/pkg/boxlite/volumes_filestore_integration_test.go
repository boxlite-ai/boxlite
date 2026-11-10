//go:build nfs_integration

// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"bufio"
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/boxlite-ai/runner/cmd/runner/config"
	"github.com/boxlite-ai/runner/pkg/api/dto"
)

// TestFilestoreIntegration runs the filestore volume path against a real NFS
// server, not the fakes. The unit tests in volumes_filestore_test.go install
// seams for the mount command and the mountpoint probe; everything those
// seams cannot observe is what this test asserts, end to end through the
// production argv:
//
//   - /proc/mounts carries exactly one kernel mount for the instance's
//     server:export spec — a real mount(8) ran, and a second getVolumeMounts
//     for another box volume on the same instance does not add a second one.
//   - The data directory's filesystem id differs from the base directory the
//     mount root lives under — reads and writes cross a real NFS boundary,
//     not the host filesystem.
//   - Data written through the mount reads back, and the 0777 chmod the
//     production path applies survives as real NFS permissions.
//   - The destroy path (record removal + orphan reclaim) unmounts and removes
//     the mount root while the server-side data survives — asserted from the
//     ganesha container's export directory by the CI workflow, because
//     in-process the unmount makes that data invisible.
//
// Server and export come from the environment so the workflow can point the
// test at its ganesha container; the defaults match a same-host server.
func TestFilestoreIntegration(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("the test mounts a real NFS export: Linux only")
	}
	if os.Geteuid() != 0 {
		t.Skip("mounting a real NFS export needs root: CI runs this test under sudo")
	}

	server := os.Getenv("FILESTORE_TEST_SERVER")
	if server == "" {
		server = "127.0.0.1"
	}
	export := os.Getenv("FILESTORE_TEST_EXPORT")
	if export == "" {
		export = "/export"
	}

	// Belt-and-suspenders around the whole test: a hard mount retries forever
	// in the kernel, and production bounds that with volumeMountTimeout (90s
	// per mount command). This deadline is not a replacement for that bound —
	// it only keeps a wedged teardown from parking the suite indefinitely.
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	// Same seam the unit tests use: mount roots and record files land under a
	// temp directory instead of /mnt or /tmp-as-production-would-pick.
	base := t.TempDir()
	volumeMountBasePathOverride = base
	t.Cleanup(func() { volumeMountBasePathOverride = "" })

	// A bare Client, not testClient: this test wants the production mount and
	// probe paths, so neither runner seam is installed, and nothing beyond
	// the registry the volume references resolve against is needed.
	c := &Client{
		logger: slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug})),
		filestoreInstances: []config.FilestoreInstance{
			{Name: "it-nfs", Server: server, Export: export},
		},
		volumeMutexes: make(map[string]*sync.Mutex),
	}

	root := filepath.Join(base, filestoreMountPrefix+"it-nfs")
	// The source spec exactly as nfsMountArgs builds it — this literal, not a
	// prefix of it, is what the production argv hands to mount(8) and what
	// /proc/mounts therefore carries.
	spec := server + ":" + export

	volumes := []dto.VolumeDTO{
		{MountPath: "/a", Filestore: &dto.FilestoreRef{Instance: "it-nfs"}},
		{MountPath: "/b", Filestore: &dto.FilestoreRef{Instance: "it-nfs"}},
	}

	mounts, err := c.getVolumeMounts(ctx, "int-box", volumes)
	if err != nil {
		t.Fatalf("getVolumeMounts failed against the real NFS server: %v", err)
	}
	if len(mounts) != 2 {
		t.Fatalf("getVolumeMounts returned %d mounts, want 2 (one per declared volume): %#v", len(mounts), mounts)
	}
	wantDirs := []string{filestoreDataDir(root, "int-box", 0), filestoreDataDir(root, "int-box", 1)}
	for i, mount := range mounts {
		if mount.hostPath != wantDirs[i] || mount.dataDir != wantDirs[i] {
			t.Errorf("mount %d hostPath/dataDir = %q/%q, want %q (declaration index fixes the suffix)", i, mount.hostPath, mount.dataDir, wantDirs[i])
		}
	}

	// A real kernel NFS mount for the spec — exactly one. Counting lines in
	// /proc/mounts is the only host-level view of "the mount exists"; a
	// directory-based probe would say mounted even for the fakes.
	if got := countProcMountsLines(t, spec); got != 1 {
		t.Fatalf("/proc/mounts carries %d lines for %s, want exactly 1", got, spec)
	}

	// Crossing the NFS boundary changes the filesystem id: the data directory
	// sits on the server's export while the base directory is host
	// filesystem. The same id would mean the writes never left the host.
	var dataStat, baseStat syscall.Statfs_t
	if err := syscall.Statfs(wantDirs[0], &dataStat); err != nil {
		t.Fatalf("statfs on the data directory %s failed: %v", wantDirs[0], err)
	}
	if err := syscall.Statfs(base, &baseStat); err != nil {
		t.Fatalf("statfs on the base directory %s failed: %v", base, err)
	}
	if dataStat.Fsid == baseStat.Fsid {
		t.Errorf("the data directory %s shares the base directory's filesystem id: writes never crossed the NFS boundary", wantDirs[0])
	}

	// Read/write through the mount. This is the round trip a box's workload
	// depends on, and unlike the chmod it cannot pass on the host filesystem
	// by accident — the Fsid check above already ruled that out.
	payload := "written through the real NFS mount"
	helloPath := filepath.Join(wantDirs[0], "hello.txt")
	if err := os.WriteFile(helloPath, []byte(payload), 0644); err != nil {
		t.Fatalf("write through the real NFS mount failed: %v", err)
	}
	got, err := os.ReadFile(helloPath)
	if err != nil {
		t.Fatalf("read back through the real NFS mount failed: %v", err)
	}
	if string(got) != payload {
		t.Errorf("read back %q, want %q", got, payload)
	}

	// NFS permissions are real (the design note in filestoreVolumeMount), so
	// the production chmod 0777 must be observable on the server's view of
	// the directory, not masked by a umask the way a plain mkdir would be.
	for _, dir := range wantDirs {
		info, err := os.Stat(dir)
		if err != nil {
			t.Fatalf("data directory %s missing: %v", dir, err)
		}
		if perm := info.Mode().Perm(); perm != 0777 {
			t.Errorf("data directory %s has mode %o, want 0777", dir, perm)
		}
	}

	// A second preparation for the same instance must reuse the mount: the
	// instance's mount is shared per design, and a second mount(8) would
	// surface here as a second /proc/mounts line.
	if _, err := c.getVolumeMounts(ctx, "int-box", volumes); err != nil {
		t.Fatalf("second getVolumeMounts failed: %v", err)
	}
	if got := countProcMountsLines(t, spec); got != 1 {
		t.Errorf("/proc/mounts carries %d lines for %s after the second getVolumeMounts, want still exactly 1 (per-instance shared mount)", got, spec)
	}

	// Destroy: drop the record (under the instance lock, as the API's cleanup
	// does), then let the orphan reclaimer decide. The bare Client's zero
	// cleanup config means the run is not skipped (interval 0), not a dry run
	// (dryRun false), and not excluded by age (exclusionPeriod 0).
	if err := c.removeBoxVolumeMountRecordLocked(ctx, "int-box", []string{"it-nfs"}); err != nil {
		t.Fatalf("removeBoxVolumeMountRecordLocked failed: %v", err)
	}
	c.CleanupOrphanedVolumeMounts(ctx)

	if got := countProcMountsLines(t, spec); got != 0 {
		t.Errorf("/proc/mounts still carries %d lines for %s after the reclaim, want 0", got, spec)
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Errorf("the mount root %s still exists after the reclaim (stat err: %v)", root, err)
	}

	// hello.txt survives on the server side of the boundary — the reclaim
	// unmounts, it never deletes data. In-process that data is invisible once
	// unmounted, so the CI workflow asserts it from the ganesha container's
	// export directory (filestore-export/int-box-0/hello.txt).
}

// countProcMountsLines counts /proc/mounts lines mentioning spec. The kernel
// records one line per mount, with the source spec as the first field, so the
// count is the number of live kernel mounts for that server:export.
func countProcMountsLines(t *testing.T, spec string) int {
	t.Helper()

	f, err := os.Open("/proc/mounts")
	if err != nil {
		t.Fatalf("open /proc/mounts failed: %v", err)
	}
	defer f.Close()

	count := 0
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		if strings.Contains(scanner.Text(), spec) {
			count++
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("scan /proc/mounts failed: %v", err)
	}
	return count
}
