// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/boxlite-ai/runner/pkg/api/dto"
)

// filestoreTestClient is testClient plus the per-key mutex map. volumeMutexFor
// writes into that map on first use, and the map's zero value is nil — only
// NewClient makes it, so a bare testClient would panic the first time an
// ensure-mount or a reclaim takes the per-instance lock.
func filestoreTestClient(t *testing.T) *Client {
	t.Helper()
	c := testClient(t)
	c.volumeMutexes = make(map[string]*sync.Mutex)
	return c
}

// useVolumeMountBasePath points every volume mount path — mount roots, data
// dirs, record files — at dir for the test. The override is a plain package
// variable rather than an env var, so restoring it is manual; tests in this
// package run sequentially, which is what makes the swap safe.
func useVolumeMountBasePath(t *testing.T, dir string) {
	t.Helper()
	volumeMountBasePathOverride = dir
	t.Cleanup(func() { volumeMountBasePathOverride = "" })
}

// installFakeMountpoint replaces the `mountpoint` binary with a script that
// appends its path argument to a log file and exits with code. The reclaim
// teardown (unmountAndRemoveDir) probes with the real exec path, not the
// probeRunner seam, so on a host without util-linux the only host-independent
// way to observe "the probe ran on this path" is to be the binary it runs.
// The log path is handed over through the environment because the probe
// command inherits the process environment.
func installFakeMountpoint(t *testing.T, exitCode int) string {
	t.Helper()

	binDir := t.TempDir()
	logPath := filepath.Join(t.TempDir(), "probes.log")

	script := fmt.Sprintf("#!/bin/sh\nprintf '%%s\\n' \"$1\" >> \"%s\"\nexit %d\n", logPath, exitCode)
	if err := os.WriteFile(filepath.Join(binDir, "mountpoint"), []byte(script), 0755); err != nil {
		t.Fatalf("failed to write fake mountpoint: %v", err)
	}

	t.Setenv("PATH", binDir)
	t.Setenv("FAKE_MOUNTPOINT_LOG", logPath)
	return logPath
}

// probeLog reads the fake mountpoint's log as the ordered list of paths it
// was asked about. A missing log means the probe never ran.
func probeLog(t *testing.T, logPath string) []string {
	t.Helper()
	data, err := os.ReadFile(logPath)
	if err != nil {
		return nil
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) == 1 && lines[0] == "" {
		return nil
	}
	return lines
}

// The mount options are the contract with the operator's provisioning: the
// instance is pinned to NFSv4.1 (the only version the Zonal/Regional tiers
// serve) and hard, with the dispatch's mountOptions joined into the same -o list.
// A quiet change here silently hands boxes a mount the instance cannot serve,
// so the whole argv is pinned, not the parts someone remembered.
func TestNfsMountArgsPinsTheProtocol(t *testing.T) {
	path := "/mnt/boxlite-filestore-ml"

	t.Run("defaults pin vers and hard", func(t *testing.T) {
		ref := &dto.FilestoreRef{Instance: "ml", Server: "10.0.0.7", Export: "/vol1"}
		want := []string{"-t", "nfs", "-o", "vers=4.1,hard", "10.0.0.7:/vol1", path}

		if got := nfsMountArgs(ref, path); !reflect.DeepEqual(got, want) {
			t.Errorf("nfsMountArgs mismatch\n got: %v\nwant: %v", got, want)
		}
	})

	t.Run("dispatch mountOptions join the same -o list", func(t *testing.T) {
		ref := &dto.FilestoreRef{Instance: "ml", Server: "10.0.0.7", Export: "/vol1", MountOptions: []string{"ro"}}
		want := []string{"-t", "nfs", "-o", "vers=4.1,hard,ro", "10.0.0.7:/vol1", path}

		if got := nfsMountArgs(ref, path); !reflect.DeepEqual(got, want) {
			t.Errorf("nfsMountArgs mismatch\n got: %v\nwant: %v", got, want)
		}
	})
}

// An NFS mount is a kernel mount with no daemon, so there is nothing that dies
// with the runner service's cgroup — unlike the FUSE backends, the systemd-run
// scope has nothing to protect and must not be added. The hard option makes a
// mount to an unreachable server retry forever, so the 90s mount timeout is
// the only thing that can end such a mount — and it can only do so if the
// command is built with CommandContext. Asserted through Cmd.Cancel, which
// exec.CommandContext sets and exec.Command leaves nil.
func TestNfsMountCmdIsNotSystemdWrappedAndIsContextBound(t *testing.T) {
	c := testClient(t)
	ref := &dto.FilestoreRef{Instance: "ml", Server: "10.0.0.7", Export: "/vol1"}

	cmd := c.getNfsMountCmd(context.Background(), ref, "/mnt/boxlite-filestore-ml")

	if filepathBase(cmd.Args[0]) != "mount" {
		t.Errorf("nfs mount command = %q, want plain mount with no systemd-run scope", filepathBase(cmd.Args[0]))
	}
	if cmd.Cancel == nil {
		t.Error("nfs mount command is not context-bound; a hard mount to an unreachable server could not be killed")
	}
	if cmd.WaitDelay != volumeMountWaitDelay {
		t.Errorf("nfs mount command WaitDelay = %s, want %s (a hard mount parks mount(8) in D state; the kill lands late)",
			cmd.WaitDelay, volumeMountWaitDelay)
	}
}

// The volume id is what makes stop/start keep the data — and what makes
// sharing possible: the same volume derives the same directory whatever box
// mounts it, and a destroyed box's data stays reachable under the volume id.
func TestFilestoreDataDirDerivation(t *testing.T) {
	root := "/mnt/boxlite-filestore-ml"

	if got, want := filestoreDataDir(root, "vol1"), filepath.Join(root, "vol1"); got != want {
		t.Errorf("filestoreDataDir(root, vol1) = %q, want %q", got, want)
	}
	if got, want := filestoreDataDir(root, "vol2"), filepath.Join(root, "vol2"); got != want {
		t.Errorf("filestoreDataDir(root, vol2) = %q, want %q", got, want)
	}
}

// The record is what the orphan reclaimer keys off, so a missing backend label,
// a missing dataDir or a torn file would all silently change what cleanup
// decides is ours to delete. The literal written shape is asserted through a
// neutral struct — both entries and the legacy paths field — because the
// record's own compat UnmarshalJSON folds paths into entries and would blur
// the write into a different shape than the file carries.
func TestRecordBoxVolumeMountsWritesEntries(t *testing.T) {
	ctx := context.Background()
	base := t.TempDir()
	useVolumeMountBasePath(t, base)

	s3Root := filepath.Join(base, "boxlite-volume-abc")
	fsRoot := filepath.Join(base, "boxlite-filestore-ml")
	dataDir := filestoreDataDir(fsRoot, "vol1")

	c := filestoreTestClient(t)
	err := c.recordBoxVolumeMounts(ctx, "box1", []volumeMount{
		{hostPath: s3Root, mountPath: "/data", rootPath: s3Root, backend: volumeBackendS3},
		{hostPath: dataDir, mountPath: "/nfs", rootPath: fsRoot, backend: volumeBackendFilestore, dataDir: dataDir, filestoreInstance: "ml"},
	})
	if err != nil {
		t.Fatalf("recordBoxVolumeMounts failed: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(getVolumeMountRecordDir(), "box1.json"))
	if err != nil {
		t.Fatalf("record file missing: %v", err)
	}
	var written struct {
		BoxID   string                `json:"boxId"`
		Entries []boxVolumeMountEntry `json:"entries"`
		Paths   []string              `json:"paths"`
	}
	if err := json.Unmarshal(data, &written); err != nil {
		t.Fatalf("record does not parse: %v", err)
	}

	if written.BoxID != "box1" {
		t.Errorf("record boxId = %q, want box1", written.BoxID)
	}
	want := []boxVolumeMountEntry{
		{Backend: volumeBackendS3, RootPath: s3Root},
		{Backend: volumeBackendFilestore, RootPath: fsRoot, FilestoreInstance: "ml", DataDir: dataDir},
	}
	if len(written.Entries) != len(want) {
		t.Fatalf("record has %d entries\n got: %#v\nwant: %#v", len(written.Entries), written.Entries, want)
	}
	for i := range want {
		if !reflect.DeepEqual(written.Entries[i], want[i]) {
			t.Errorf("entry %d mismatch\n got: %#v\nwant: %#v", i, written.Entries[i], want[i])
		}
	}

	// paths (legacy) is written alongside entries for one release cycle: a
	// runner binary rolled back to the pre-entries version reads only paths,
	// and an entries-only record would read as zero references — its cleanup
	// would then reclaim live mounts. Same rootPath set as the entries carry.
	if wantPaths := []string{s3Root, fsRoot}; !reflect.DeepEqual(written.Paths, wantPaths) {
		t.Errorf("record paths = %v, want %v (the legacy double-write)", written.Paths, wantPaths)
	}

	// Read back through the production reader: the fold turns paths into extra
	// entries alongside the real ones, so the reader sees four entries — but
	// the in-use map keys dedup the overlap, and each rootPath counts exactly
	// once. A fold that double-counted would surface here as len(inUse) > 2.
	inUse, err := c.getRecordedVolumeMounts()
	if err != nil {
		t.Fatalf("getRecordedVolumeMounts failed: %v", err)
	}
	if len(inUse) != 2 || !inUse[s3Root] || !inUse[fsRoot] {
		t.Errorf("in-use mounts = %v, want exactly %q and %q once each", inUse, s3Root, fsRoot)
	}

	// The write is temp file plus rename so a reader mid-file never sees a torn
	// half; the temp name does not end in .json precisely so the record scanner
	// skips it. A leftover .tmp means the rename path was skipped or broken.
	leftovers, err := filepath.Glob(filepath.Join(getVolumeMountRecordDir(), "*.tmp"))
	if err != nil {
		t.Fatalf("glob failed: %v", err)
	}
	if len(leftovers) != 0 {
		t.Errorf("record write left temp files behind: %v", leftovers)
	}
}

// A record written before filestore existed carries bare paths and no backend.
// Every reader must see those as object-storage entries — filestore did not
// exist then, and the reclaimer counts the path regardless — so the legacy
// shape folds, the path stays in use, and nothing the old records referenced
// can be reclaimed.
func TestLegacyRecordReadsAsObjectStorageEntries(t *testing.T) {
	base := t.TempDir()
	useVolumeMountBasePath(t, base)

	recordDir := getVolumeMountRecordDir()
	if err := os.MkdirAll(recordDir, 0755); err != nil {
		t.Fatalf("mkdir record dir: %v", err)
	}
	legacyPath := filepath.Join(base, "boxlite-volume-abc")
	legacy := fmt.Sprintf(`{"boxId":"box-legacy","paths":["%s"]}`, legacyPath)
	if err := os.WriteFile(filepath.Join(recordDir, "box-legacy.json"), []byte(legacy), 0644); err != nil {
		t.Fatalf("write legacy record: %v", err)
	}

	// The fold itself: reading the record through the compat path must label
	// the bare path as an object-storage mount.
	var record boxVolumeMountRecord
	data, err := os.ReadFile(filepath.Join(recordDir, "box-legacy.json"))
	if err != nil {
		t.Fatalf("read legacy record: %v", err)
	}
	if err := json.Unmarshal(data, &record); err != nil {
		t.Fatalf("legacy record does not parse: %v", err)
	}
	if len(record.Entries) != 1 || record.Entries[0].Backend != volumeBackendS3 || record.Entries[0].RootPath != legacyPath {
		t.Errorf("legacy record folded to %#v, want one s3 entry for %q", record.Entries, legacyPath)
	}

	c := filestoreTestClient(t)
	inUse, err := c.getRecordedVolumeMounts()
	if err != nil {
		t.Fatalf("getRecordedVolumeMounts failed: %v", err)
	}
	if !inUse[legacyPath] {
		t.Errorf("the legacy path %q is not counted as in use: %v", legacyPath, inUse)
	}
}

// fakeFilestoreMounts installs the two test seams over the NFS mount path so a
// test can drive it without a real mount. The probe answers from the same map
// the fake mount command fills, which is what makes the readiness wait pass:
// the moment a root is "mounted", every later probe sees it — including the
// next goroutine's is-mounted check. Counting real mounts would need a real
// NFS server; counting through these seams needs none.
type fakeFilestoreMounts struct {
	mounts atomic.Int64
	probes atomic.Int64

	mu      sync.Mutex
	mounted map[string]bool
}

func installFakeFilestoreMounts(c *Client) *fakeFilestoreMounts {
	f := &fakeFilestoreMounts{mounted: make(map[string]bool)}
	c.mountRunner = func(cmd *exec.Cmd) error {
		f.mounts.Add(1)
		f.mu.Lock()
		defer f.mu.Unlock()
		f.mounted[cmd.Args[len(cmd.Args)-1]] = true
		return nil
	}
	c.probeRunner = func(_ context.Context, path string) (bool, error) {
		f.probes.Add(1)
		f.mu.Lock()
		defer f.mu.Unlock()
		return f.mounted[path], nil
	}
	return f
}

// Concurrent preparation of filestore volumes on one instance must run the
// mount command exactly once. The per-instance mutex is taken by
// filestoreVolumeMount (ensureFilestoreMounted no longer locks on its own) and
// held across ensure-mount, data directory and record write, so the goroutines
// serialize and whoever wins mounts and becomes ready before releasing the
// lock — everyone else's probe answers "mounted" and skips. This is the
// design's decidable assertion: a mount command per goroutine (10), or a probe
// that cannot mark the map (so every goroutine mounts), both fail here.
func TestConcurrentGetVolumeMountsRunsFilestoreMountOnce(t *testing.T) {
	ctx := context.Background()
	useVolumeMountBasePath(t, t.TempDir())

	c := filestoreTestClient(t)
	fake := installFakeFilestoreMounts(c)

	volumes := []dto.VolumeDTO{{VolumeId: "vol-concurrent", MountPath: "/data", Filestore: &dto.FilestoreRef{Instance: "ml-scratch", Server: "10.0.0.7", Export: "/vol1"}}}

	const goroutines = 10
	errs := make([]error, goroutines)
	var wg sync.WaitGroup
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := c.getVolumeMounts(ctx, "box1", volumes)
			errs[i] = err
		}(i)
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Errorf("goroutine %d: getVolumeMounts failed: %v", i, err)
		}
	}
	if got := fake.mounts.Load(); got != 1 {
		t.Errorf("mount command ran %d times, want exactly once", got)
	}
	if got := fake.probes.Load(); got == 0 {
		t.Error("no probe ever ran, so the skip-after-mount path was never exercised")
	}
}

// getVolumeMounts is the whole filestore preparation for a box's volume list:
// under one instance mutex it mounts the instance once (however many volumes
// reference it), derives each volume's data directory from the declaration
// order, and leaves both the directories and the referencing record behind.
// Every observable here is something a box's first bind mount depends on.
func TestGetVolumeMountsPreparesFilestoreVolumes(t *testing.T) {
	ctx := context.Background()
	base := t.TempDir()
	useVolumeMountBasePath(t, base)

	root := filepath.Join(base, filestoreMountPrefix+"ml-scratch")

	c := filestoreTestClient(t)
	fake := installFakeFilestoreMounts(c)

	mounts, err := c.getVolumeMounts(ctx, "box1", []dto.VolumeDTO{
		{VolumeId: "vol-a", MountPath: "/a", Filestore: &dto.FilestoreRef{Instance: "ml-scratch", Server: "10.0.0.7", Export: "/vol1"}},
		{VolumeId: "vol-b", MountPath: "/b", Filestore: &dto.FilestoreRef{Instance: "ml-scratch", Server: "10.0.0.7", Export: "/vol1"}},
	})
	if err != nil {
		t.Fatalf("getVolumeMounts failed: %v", err)
	}

	// Two declared volumes on one instance: two distinct data directories,
	// each named by its volume id, behind one shared mount root, both labeled
	// filestore with the instance that backs them.
	want := []volumeMount{
		{
			hostPath:          filestoreDataDir(root, "vol-a"),
			mountPath:         "/a",
			rootPath:          root,
			backend:           volumeBackendFilestore,
			dataDir:           filestoreDataDir(root, "vol-a"),
			filestoreInstance: "ml-scratch",
		},
		{
			hostPath:          filestoreDataDir(root, "vol-b"),
			mountPath:         "/b",
			rootPath:          root,
			backend:           volumeBackendFilestore,
			dataDir:           filestoreDataDir(root, "vol-b"),
			filestoreInstance: "ml-scratch",
		},
	}
	if len(mounts) != len(want) {
		t.Fatalf("getVolumeMounts returned %d mounts\n got: %#v\nwant: %#v", len(mounts), mounts, want)
	}
	for i := range want {
		if !reflect.DeepEqual(mounts[i], want[i]) {
			t.Errorf("mount %d mismatch\n got: %#v\nwant: %#v", i, mounts[i], want[i])
		}
	}

	// The data directories must exist on disk and be world-writable: NFS
	// permissions are real, so the chmod after mkdir is load-bearing, not
	// decoration.
	for _, m := range mounts {
		info, err := os.Stat(m.hostPath)
		if err != nil {
			t.Fatalf("data directory %s missing: %v", m.hostPath, err)
		}
		if got := info.Mode().Perm(); got != 0777 {
			t.Errorf("data directory %s has mode %o, want 0777", m.hostPath, got)
		}
	}

	// Both volumes share the instance's mount root, so the mount command runs
	// once for the pair.
	if got := fake.mounts.Load(); got != 1 {
		t.Errorf("mount command ran %d times, want exactly once for two volumes on one instance", got)
	}

	// The referencing record must already carry both entries — and the legacy
	// paths field must carry both volumes' rootPath alongside them, or a
	// rolled-back runner binary would read the box as referencing nothing and
	// reclaim a live mount. Read through a neutral struct: the record's own
	// UnmarshalJSON folds paths into entries and would blur the count.
	data, err := os.ReadFile(filepath.Join(getVolumeMountRecordDir(), "box1.json"))
	if err != nil {
		t.Fatalf("box volume mount record missing: %v", err)
	}
	var written struct {
		Entries []boxVolumeMountEntry `json:"entries"`
		Paths   []string              `json:"paths"`
	}
	if err := json.Unmarshal(data, &written); err != nil {
		t.Fatalf("record does not parse: %v", err)
	}
	if len(written.Entries) != 2 {
		t.Errorf("record has %d entries, want 2 (one per declared volume): %#v", len(written.Entries), written.Entries)
	}
	for _, m := range mounts {
		found := false
		for _, p := range written.Paths {
			if p == m.rootPath {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("record paths %v does not contain the rootPath %s of volume %s (legacy double-write missing)", written.Paths, m.rootPath, m.mountPath)
		}
	}
}

// The volume id names the data directory — the bucket-alignment contract:
// two boxes mounting the same volume land in the same directory and share
// data, a destroyed box's directory stays reachable by mounting the volume
// into a new box, and one box declaring the same volume at two guest paths
// binds the same directory twice.
func TestFilestoreVolumesShareTheDirectoryByVolumeId(t *testing.T) {
	ctx := context.Background()
	base := t.TempDir()
	useVolumeMountBasePath(t, base)

	c := filestoreTestClient(t)
	installFakeFilestoreMounts(c)

	box1, err := c.getVolumeMounts(ctx, "box1", []dto.VolumeDTO{
		{VolumeId: "vol-shared", MountPath: "/data", Filestore: &dto.FilestoreRef{Instance: "ml-scratch", Server: "10.0.0.7", Export: "/vol1"}},
	})
	if err != nil {
		t.Fatalf("box1 getVolumeMounts failed: %v", err)
	}

	// A second box mounting the same volume derives the same data directory:
	// what makes cross-box sharing (and post-destroy remount) real.
	box2, err := c.getVolumeMounts(ctx, "box2", []dto.VolumeDTO{
		{VolumeId: "vol-shared", MountPath: "/data", Filestore: &dto.FilestoreRef{Instance: "ml-scratch", Server: "10.0.0.7", Export: "/vol1"}},
	})
	if err != nil {
		t.Fatalf("box2 getVolumeMounts failed: %v", err)
	}
	if box1[0].hostPath != box2[0].hostPath {
		t.Fatalf("boxes sharing a volume derived different data directories: %q vs %q", box1[0].hostPath, box2[0].hostPath)
	}

	// One box declaring the same volume twice binds the same directory at
	// both guest paths.
	oneBox, err := c.getVolumeMounts(ctx, "box3", []dto.VolumeDTO{
		{VolumeId: "vol-shared", MountPath: "/x", Filestore: &dto.FilestoreRef{Instance: "ml-scratch", Server: "10.0.0.7", Export: "/vol1"}},
		{VolumeId: "vol-shared", MountPath: "/y", Filestore: &dto.FilestoreRef{Instance: "ml-scratch", Server: "10.0.0.7", Export: "/vol1"}},
	})
	if err != nil {
		t.Fatalf("box3 getVolumeMounts failed: %v", err)
	}
	if oneBox[0].hostPath != oneBox[1].hostPath {
		t.Fatalf("one box declaring a volume twice derived different data directories: %q vs %q", oneBox[0].hostPath, oneBox[1].hostPath)
	}
}

// Design §4.5.2 ordering, pinned end to end: the referencing record is written
// inside filestoreVolumeMount's critical section, so the moment getVolumeMounts
// returns the reference is already visible — there is no window in which a
// reclaim's in-lock rescan could miss it. If the record write ever moved out
// of the lock, the reclaim here would proceed past the rescan to the probe
// (and then the umount), the probe counter would move, and this test would
// fail.
func TestRecordWriteHappensUnderTheInstanceLock(t *testing.T) {
	ctx := context.Background()
	base := t.TempDir()
	useVolumeMountBasePath(t, base)

	root := filepath.Join(base, filestoreMountPrefix+"ml-scratch")

	c := filestoreTestClient(t)
	fake := installFakeFilestoreMounts(c)

	if _, err := c.getVolumeMounts(ctx, "box1", []dto.VolumeDTO{
		{VolumeId: "vol1", MountPath: "/data", Filestore: &dto.FilestoreRef{Instance: "ml-scratch", Server: "10.0.0.7", Export: "/vol1"}},
	}); err != nil {
		t.Fatalf("getVolumeMounts failed: %v", err)
	}

	if _, err := os.Stat(filepath.Join(getVolumeMountRecordDir(), "box1.json")); err != nil {
		t.Fatalf("box volume mount record missing right after getVolumeMounts: %v", err)
	}

	probesBefore := fake.probes.Load()
	c.reclaimFilestoreMount(ctx, root)
	if got := fake.probes.Load(); got != probesBefore {
		t.Errorf("reclaim ran %d additional probes; the in-lock rescan must see the record and skip before any probe or umount", got-probesBefore)
	}
}

// The outer cleanup scan is stale the moment it finishes: between it and the
// unmount, a Create can mount the instance and write a reference record. The
// in-lock rescan is what closes that window — it must see the reference and
// skip before any probe or umount happens. The probe here is the real exec
// path with a fake `mountpoint` binary: if the rescan were ever removed,
// reclaim would reach the probe (and try to unmount a live mount), the log
// would gain an entry, and this test would fail. With the rescan intact the
// probe is never reached.
func TestReclaimRescansRecordsUnderTheInstanceLock(t *testing.T) {
	ctx := context.Background()
	base := t.TempDir()
	useVolumeMountBasePath(t, base)
	probeLogPath := installFakeMountpoint(t, 0 /* claim mounted */)

	root := filepath.Join(base, "boxlite-filestore-ml")
	if err := os.MkdirAll(root, 0755); err != nil {
		t.Fatalf("mkdir mount root: %v", err)
	}

	// Simulate a create that landed between the outer scan and the reclaim:
	// nothing referenced the root when cleanup decided "orphaned", and by the
	// time the reclaim takes the lock, the record exists.
	c := filestoreTestClient(t)
	if err := c.recordBoxVolumeMounts(ctx, "box-late", []volumeMount{
		{hostPath: filestoreDataDir(root, "vol-late"), mountPath: "/nfs", rootPath: root, backend: volumeBackendFilestore, filestoreInstance: "ml"},
	}); err != nil {
		t.Fatalf("recordBoxVolumeMounts failed: %v", err)
	}

	c.reclaimFilestoreMount(ctx, root)

	if got := probeLog(t, probeLogPath); got != nil {
		t.Errorf("reclaim probed %v; the in-lock rescan must see the reference and skip before any probe or umount", got)
	}
}

// The cleanup scan must cover both mount families and act only on what the
// records prove.
//
// a. A filestore root a record still references survives — and to prove the
//
//	loop actually ran and decided rather than aborting early, an orphaned
//	object-storage directory planted next to it is reclaimed in the same run.
//	The filestore root is never probed; the orphan is.
//
// b. A filestore root no record references is reclaimed: the probe (fake,
//
//	answering "not a mountpoint") reports not mounted, the directory is
//	empty, and it is removed. The probe log naming the root is what makes
//	the removal decidable — it shows the reclaim path was reached, rather
//	than the run passing because the directory survived for some other
//	reason.
func TestCleanupOrphanedVolumeMountsEndToEnd(t *testing.T) {
	ctx := context.Background()

	t.Run("a referenced filestore mount survives", func(t *testing.T) {
		base := t.TempDir()
		useVolumeMountBasePath(t, base)
		probeLogPath := installFakeMountpoint(t, 1 /* not mounted */)

		root := filepath.Join(base, "boxlite-filestore-ml")
		if err := os.MkdirAll(root, 0755); err != nil {
			t.Fatalf("mkdir mount root: %v", err)
		}

		c := filestoreTestClient(t)
		if err := c.recordBoxVolumeMounts(ctx, "box-a", []volumeMount{
			{hostPath: filestoreDataDir(root, "vol-a"), mountPath: "/nfs", rootPath: root, backend: volumeBackendFilestore, filestoreInstance: "ml"},
		}); err != nil {
			t.Fatalf("recordBoxVolumeMounts failed: %v", err)
		}

		// An unreferenced object-storage directory: if cleanup never entered
		// its loop (a glob or records error aborts silently), this control
		// would survive and the survival of the filestore root would mean
		// nothing. Its removal proves the run decided.
		orphan := filepath.Join(base, "boxlite-volume-orphan")
		if err := os.MkdirAll(orphan, 0755); err != nil {
			t.Fatalf("mkdir orphan: %v", err)
		}

		c.CleanupOrphanedVolumeMounts(ctx)

		if _, err := os.Stat(root); err != nil {
			t.Errorf("the referenced filestore root %s did not survive cleanup: %v", root, err)
		}
		if _, err := os.Stat(orphan); !os.IsNotExist(err) {
			t.Errorf("the orphaned object-storage directory %s was not reclaimed (stat err: %v)", orphan, err)
		}
		if got, want := probeLog(t, probeLogPath), []string{orphan}; !reflect.DeepEqual(got, want) {
			t.Errorf("probe log = %v, want exactly [%s]; the referenced root must not be probed at all", got, orphan)
		}
	})

	t.Run("an orphaned filestore mount is reclaimed", func(t *testing.T) {
		base := t.TempDir()
		useVolumeMountBasePath(t, base)
		probeLogPath := installFakeMountpoint(t, 1 /* not mounted */)

		// getRecordedVolumeMounts refuses to act without the records dir, and
		// cleanup honors that refusal — the dir must exist even when empty.
		if err := os.MkdirAll(getVolumeMountRecordDir(), 0755); err != nil {
			t.Fatalf("mkdir record dir: %v", err)
		}
		root := filepath.Join(base, "boxlite-filestore-ml")
		if err := os.MkdirAll(root, 0755); err != nil {
			t.Fatalf("mkdir mount root: %v", err)
		}

		c := filestoreTestClient(t)
		c.CleanupOrphanedVolumeMounts(ctx)

		if _, err := os.Stat(root); !os.IsNotExist(err) {
			t.Errorf("the orphaned filestore root %s was not reclaimed (stat err: %v)", root, err)
		}
		if got, want := probeLog(t, probeLogPath), []string{root}; !reflect.DeepEqual(got, want) {
			t.Errorf("probe log = %v, want exactly [%s]; the reclaim must have reached the probe on the root", got, root)
		}
	})
}

// The volume id names the data directory under the instance's mount root, so
// the id is path material from the dispatching API's hands. A
// traversal-shaped id would escape the mount root entirely; an empty one
// would name the mount root itself, putting every volume of the instance
// behind one box's bind mount. The control plane mints uuids, but this
// boundary must not lean on that — same posture as the box id guard.
func TestFilestoreVolumeIdIsPathGuarded(t *testing.T) {
	ctx := context.Background()
	base := t.TempDir()
	useVolumeMountBasePath(t, base)

	c := filestoreTestClient(t)
	fake := installFakeFilestoreMounts(c)

	for _, id := range []string{"", "../escape", "a/b", "a\\b", ".."} {
		_, err := c.getVolumeMounts(ctx, "box1", []dto.VolumeDTO{
			{VolumeId: id, MountPath: "/data", Filestore: &dto.FilestoreRef{Instance: "ml-scratch", Server: "10.0.0.7", Export: "/vol1"}},
		})
		if err == nil {
			t.Fatalf("volume id %q: expected the path guard to refuse it, got nil", id)
		}
		if !strings.Contains(err.Error(), "invalid filestore volume id") {
			t.Fatalf("volume id %q: expected the volume id guard error, got %q", id, err)
		}
	}

	// The refusal must precede all mount and directory work: nothing ran.
	if fake.mounts.Load() != 0 {
		t.Errorf("mount command ran %d times; the guard must refuse before any mount work", fake.mounts.Load())
	}
}

// A create that fails partway through its volume list must not leave the
// partial record behind. Filestore volumes write their record entries inside
// the instance critical section, so a failure at a later volume leaves an
// earlier volume's entry already on disk. Without deletion no box ever exists
// to destroy, the dangling entry counts a reference forever, and the
// reclaimer never reclaims the NFS mount. This pins the rollback wiring on
// Create's getVolumeMounts failure path.
func TestCreateRollsBackTheRecordWhenALaterVolumeFails(t *testing.T) {
	ctx := context.Background()
	base := t.TempDir()
	useVolumeMountBasePath(t, base)

	c := filestoreTestClient(t)
	installFakeFilestoreMounts(c)

	outbound := true
	_, _, err := c.Create(ctx, dto.CreateBoxDTO{
		Id:              "abc123def456",
		OutboundEnabled: &outbound,
		Volumes: []dto.VolumeDTO{
			{VolumeId: "vol-ok", MountPath: "/a", Filestore: &dto.FilestoreRef{Instance: "ml-scratch", Server: "10.0.0.7", Export: "/vol1"}},
			{VolumeId: "../escape", MountPath: "/b", Filestore: &dto.FilestoreRef{Instance: "ml-scratch", Server: "10.0.0.7", Export: "/vol1"}},
		},
	})
	if err == nil {
		t.Fatal("expected the volume-id guard failure from the second volume, got nil")
	}
	if !strings.Contains(err.Error(), "invalid filestore volume id") {
		t.Fatalf("expected the volume-id guard error, got %q", err)
	}

	// The first volume's entry was already on disk inside its instance
	// critical section. The failed create must remove it: no box exists to
	// ever destroy, so the dangling entry would count a reference forever and
	// keep the NFS mount from ever reclaiming.
	recordPath := filepath.Join(getVolumeMountRecordDir(), "abc123def456.json")
	if _, statErr := os.Stat(recordPath); !os.IsNotExist(statErr) {
		t.Fatalf("volume mount record survived the failed create: %v", statErr)
	}
}
