// Copyright 2025 Daytona Platforms Inc.
// Copyright 2025-2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/boxlite-ai/common-go/pkg/log"
	"github.com/boxlite-ai/runner/cmd/runner/config"
	"github.com/boxlite-ai/runner/pkg/api/dto"
)

const volumeMountPrefix = "boxlite-volume-"
const volumeMountRecordDir = ".boxlite-volume-mounts"

// How long a mount command may run before it is killed. The request context
// cannot serve as this bound: Create is handed an undeadlined gin request
// context, and gcsfuse retries an unreachable bucket forever, so without an
// explicit deadline a misconfigured backend wedges box creation indefinitely.
const volumeMountTimeout = 90 * time.Second

// Bound for the local mount probes and teardown. A wedged FUSE mount blocks
// stat and umount indefinitely, which is exactly the state these run in.
const volumeProbeTimeout = 10 * time.Second

// Bound for the readiness loop as a whole. It has to be a deadline rather than
// a retry count: each probe can now burn volumeProbeTimeout against a wedged
// mount, so counting attempts would multiply into minutes of holding the
// per-volume mutex.
const volumeReadyTimeout = 30 * time.Second

type volumeCleanupConfig struct {
	interval        time.Duration
	dryRun          bool
	exclusionPeriod time.Duration
}

type volumeMount struct {
	hostPath  string
	mountPath string
	rootPath  string
}

type boxVolumeMountRecord struct {
	BoxID string   `json:"boxId"`
	Paths []string `json:"paths"`
}

func getVolumeMountBasePath() string {
	if config.GetEnvironment() == "development" {
		return "/tmp"
	}
	return "/mnt"
}

func (c *Client) getVolumeMounts(ctx context.Context, volumes []dto.VolumeDTO) ([]volumeMount, error) {
	volumeMounts := make([]volumeMount, 0, len(volumes))

	fuseMountedVolumes := make(map[string]bool)

	for _, vol := range volumes {
		volumeIdPrefixed := fmt.Sprintf("%s%s", volumeMountPrefix, vol.VolumeId)
		baseMountPath := filepath.Join(getVolumeMountBasePath(), volumeIdPrefixed)

		subpathStr := ""
		if vol.Subpath != nil {
			subpathStr = *vol.Subpath
		}

		if !fuseMountedVolumes[volumeIdPrefixed] {
			err := c.ensureVolumeFuseMounted(ctx, volumeIdPrefixed, baseMountPath)
			if err != nil {
				return nil, err
			}
			fuseMountedVolumes[volumeIdPrefixed] = true
		}

		bindSource := baseMountPath
		if vol.Subpath != nil && *vol.Subpath != "" {
			bindSource = filepath.Join(baseMountPath, *vol.Subpath)
			if !strings.HasPrefix(filepath.Clean(bindSource), filepath.Clean(baseMountPath)) {
				return nil, fmt.Errorf("invalid subpath %q: resolves outside volume mount", *vol.Subpath)
			}
			err := os.MkdirAll(bindSource, 0755)
			if err != nil {
				return nil, fmt.Errorf("failed to create subpath directory %s: %s", bindSource, err)
			}
		}

		c.logger.DebugContext(ctx, "binding volume subpath", "volumeId", volumeIdPrefixed, "subpath", subpathStr, "mountPath", vol.MountPath)
		volumeMounts = append(volumeMounts, volumeMount{
			hostPath:  bindSource,
			mountPath: vol.MountPath,
			rootPath:  baseMountPath,
		})
	}

	return volumeMounts, nil
}

func (c *Client) ensureVolumeMountsFromMetadata(ctx context.Context, boxID string, metadata map[string]string) error {
	if metadata == nil {
		return nil
	}

	volumesJSON, ok := metadata["volumes"]
	if !ok {
		return nil
	}

	var volumes []dto.VolumeDTO
	if err := json.Unmarshal([]byte(volumesJSON), &volumes); err != nil {
		return nil
	}
	if len(volumes) == 0 {
		return nil
	}

	volumeMounts, err := c.getVolumeMounts(ctx, volumes)
	if err != nil {
		return err
	}

	return c.recordBoxVolumeMounts(ctx, boxID, volumeMounts)
}

func (c *Client) ensureVolumeFuseMounted(ctx context.Context, volumeId string, mountPath string) error {
	c.volumeMutexesMutex.Lock()
	volumeMutex, exists := c.volumeMutexes[volumeId]
	if !exists {
		volumeMutex = &sync.Mutex{}
		c.volumeMutexes[volumeId] = volumeMutex
	}
	c.volumeMutexesMutex.Unlock()

	volumeMutex.Lock()
	defer volumeMutex.Unlock()

	mounted, err := c.isDirectoryMounted(ctx, mountPath)
	if err != nil {
		// Guessing here is what makes a stale mount look absent: we would mount
		// over it, then treat the directory as pre-existing and tear it down.
		return fmt.Errorf("cannot determine whether volume %s is already mounted: %w", volumeId, err)
	}
	if mounted {
		c.logger.DebugContext(ctx, "volume already mounted", "volumeId", volumeId, "mountPath", mountPath)
		return nil
	}

	_, statErr := os.Stat(mountPath)
	dirExisted := statErr == nil

	if err = os.MkdirAll(mountPath, 0755); err != nil {
		return fmt.Errorf("failed to create mount directory %s: %s", mountPath, err)
	}

	c.logger.InfoContext(ctx, "mounting volume", "volumeId", volumeId, "mountPath", mountPath, "backend", c.volumeBackend)

	mountCtx, cancelMount := context.WithTimeout(ctx, volumeMountTimeout)
	defer cancelMount()

	cmd := c.getMountCmd(mountCtx, volumeId, mountPath)
	if err = cmd.Run(); err != nil {
		c.cleanUpFailedMount(ctx, mountPath, dirExisted)
		return fmt.Errorf("failed to mount volume %s to %s via %s backend: %s", volumeId, mountPath, c.volumeBackend, err)
	}

	if err = c.waitForMountReady(ctx, mountPath); err != nil {
		c.cleanUpFailedMount(ctx, mountPath, dirExisted)
		return fmt.Errorf("mount %s not ready after mounting: %s", mountPath, err)
	}

	c.logger.InfoContext(ctx, "mounted volume", "volumeId", volumeId, "mountPath", mountPath, "backend", c.volumeBackend)
	return nil
}

// mountProbeCmd and umountCmd exist as separate builders so a test can assert
// the commands are context-bound. Running them cannot show that: mountpoint
// and umount fail on an ordinary directory whatever the context says.
func mountProbeCmd(ctx context.Context, path string) *exec.Cmd {
	return exec.CommandContext(ctx, "mountpoint", path)
}

func umountCmd(ctx context.Context, path string) *exec.Cmd {
	return exec.CommandContext(ctx, "umount", path)
}

// cleanupContext detaches from the caller's cancellation while keeping its
// values, and gives the teardown a bound of its own. Extracted so a test can
// hold it to that: derived straight from ctx, the whole cleanup becomes a
// no-op in the cases that call it.
func cleanupContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), volumeProbeTimeout*2)
}

// cleanUpFailedMount undoes a mount attempt that did not reach a usable state.
//
// It deliberately does not use the caller's context. The two things that bring
// us here — volumeMountTimeout firing, and the client disconnecting — both
// leave that context cancelled, and every exec under a cancelled context
// returns without running. Inheriting it would mean the cleanup silently does
// nothing in exactly the cases it exists for.
//
// The unmount is not gated on dirExisted: a mount tool can attach to a
// directory that was already there, and leaving that behind is the worse
// failure. A later ensureVolumeFuseMounted would see isDirectoryMounted report
// true and hand a box a wedged mount. Only removing the directory is gated,
// because only then did we create it.
func (c *Client) cleanUpFailedMount(ctx context.Context, mountPath string, dirExisted bool) {
	cleanupCtx, cancel := cleanupContext(ctx)
	defer cancel()

	var unmountErr error
	mounted, probeErr := c.isDirectoryMounted(cleanupCtx, mountPath)
	if probeErr != nil {
		// Unknown state: leave both the mount and the directory alone rather
		// than remove a path that may still be a live mountpoint.
		c.logger.WarnContext(ctx, "skipping mount cleanup, probe inconclusive", "path", mountPath, "error", probeErr)
		return
	}
	if mounted {
		if unmountErr = c.umountPath(cleanupCtx, mountPath); unmountErr != nil {
			c.logger.WarnContext(ctx, "failed to unmount after failed mount", "path", mountPath, "error", unmountErr)
		}
	}

	if shouldRemoveMountDir(dirExisted, unmountErr) {
		if err := os.Remove(mountPath); err != nil {
			c.logger.WarnContext(ctx, "failed to remove mount directory", "path", mountPath, "error", err)
		}
	}
}

// shouldRemoveMountDir keeps the teardown ordering honest. The directory goes
// only when we created it AND nothing is still mounted on it: removing a live
// mountpoint stranded the mount under an empty path, and removing a directory
// we did not create destroys someone else's.
func shouldRemoveMountDir(dirExisted bool, unmountErr error) bool {
	return !dirExisted && unmountErr == nil
}

// isDirectoryMounted answers whether path is a mountpoint. The error is
// non-nil only when the probe could not run to an answer — a finished context,
// or a deadline hit mid-probe.
//
// The two must stay distinguishable. A probe that cannot run and reports
// "false" is not a harmless default: callers use it to decide whether a mount
// is already in place and whether one is theirs to tear down, so the false
// negative makes them remount over a live mount, or unmount someone else's.
func (c *Client) isDirectoryMounted(ctx context.Context, path string) (bool, error) {
	probeCtx, cancel := context.WithTimeout(ctx, volumeProbeTimeout)
	defer cancel()

	_, err := mountProbeCmd(probeCtx, path).Output()
	if probeCtx.Err() != nil {
		return false, fmt.Errorf("mount probe on %s did not complete: %w", path, probeCtx.Err())
	}
	if err == nil {
		return true, nil
	}

	// A non-zero exit is mountpoint's way of saying "not a mountpoint"; any
	// other failure means we never got an answer.
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return false, nil
	}
	return false, fmt.Errorf("mount probe on %s failed: %w", path, err)
}

// umountPath tears a mount down under the same bound as the probe: a mount
// whose backend is gone will not answer, and an unbounded umount here would
// simply move the hang from the mount to its cleanup.
func (c *Client) umountPath(ctx context.Context, path string) error {
	umountCtx, cancel := context.WithTimeout(ctx, volumeProbeTimeout)
	defer cancel()

	return umountCmd(umountCtx, path).Run()
}

// readable answers whether the mountpoint can be listed, without inheriting a
// hang if it cannot. os.Stat and os.ReadDir are uninterruptible on a FUSE mount
// whose daemon has attached and then wedged — exactly the state this readiness
// loop exists to detect — so the syscalls run on their own goroutine and the
// caller stops waiting on the bound. That goroutine stays parked until the
// kernel releases it; the alternative is parking the whole box creation.
func readable(ctx context.Context, path string) bool {
	probeCtx, cancel := context.WithTimeout(ctx, volumeProbeTimeout)
	defer cancel()

	done := make(chan bool, 1)
	go func() {
		if _, err := os.Stat(path); err != nil {
			done <- false
			return
		}
		_, err := os.ReadDir(path)
		done <- err == nil
	}()

	select {
	case ok := <-done:
		return ok
	case <-probeCtx.Done():
		return false
	}
}

// notReadyError names why the readiness wait ended: the caller gave up, or the
// mount simply never came up within our own bound. Both reach here through the
// same finished readyCtx, so the caller's context is what tells them apart.
func notReadyError(ctx context.Context, readyCtx context.Context) error {
	if ctx.Err() != nil {
		return fmt.Errorf("context cancelled while waiting for mount ready: %w", ctx.Err())
	}
	return fmt.Errorf("mount did not become ready within %s: %w", volumeReadyTimeout, readyCtx.Err())
}

func (c *Client) waitForMountReady(ctx context.Context, path string) error {
	sleepDuration := 100 * time.Millisecond

	readyCtx, cancel := context.WithTimeout(ctx, volumeReadyTimeout)
	defer cancel()

	for attempt := 1; ; attempt++ {
		mounted, err := c.isDirectoryMounted(readyCtx, path)
		if err != nil {
			return notReadyError(ctx, readyCtx)
		}
		if !mounted {
			return fmt.Errorf("mount disappeared during readiness check")
		}

		if readable(readyCtx, path) {
			c.logger.InfoContext(ctx, "mount is ready", "path", path, "attempts", attempt)
			return nil
		}

		select {
		case <-readyCtx.Done():
			return notReadyError(ctx, readyCtx)
		case <-time.After(sleepDuration):
		}
	}
}

// Volume storage backends the runner can mount with, selected by
// VOLUME_STORAGE_BACKEND. The default is s3, so a deployment that does not set
// it keeps mount-s3 and its exact argv.
//
// Each value names a binary the host must already provide — s3 needs mount-s3,
// gcs needs gcsfuse 2.0 or later, which is where --metadata-cache-ttl-secs
// replaced --stat-cache-ttl — and neither is installed by the runner. Verified
// against mount-s3 1.20.0 and gcsfuse 3.8.4. The API must be set to the same
// backend: it creates the buckets mounted here.
const (
	volumeBackendS3  = "s3"
	volumeBackendGCS = "gcs"
)

// mountSpec is one backend's mount invocation. Keeping the binary, its argv
// and its credential environment together is what lets wrapMountCmd stay
// backend-agnostic.
type mountSpec struct {
	bin  string
	args []string
	env  []string
}

func (c *Client) getMountCmd(ctx context.Context, volume string, path string) *exec.Cmd {
	if c.volumeBackend == volumeBackendGCS {
		return c.wrapMountCmd(ctx, gcsfuseMountSpec(volume, path))
	}
	return c.wrapMountCmd(ctx, c.mountS3Spec(volume, path))
}

// mountS3Spec builds the Mountpoint for Amazon S3 invocation. Credentials are
// injected only when configured: a runner host sets none of them, so mount-s3
// falls through to the EC2 instance role.
func (c *Client) mountS3Spec(bucket string, path string) mountSpec {
	args := []string{"--allow-other", "--allow-delete", "--allow-overwrite", "--file-mode", "0666", "--dir-mode", "0777"}
	args = append(args, bucket, path)

	var envVars []string
	if c.awsEndpointUrl != "" {
		envVars = append(envVars, "AWS_ENDPOINT_URL="+c.awsEndpointUrl)
	}
	if c.awsAccessKeyId != "" {
		envVars = append(envVars, "AWS_ACCESS_KEY_ID="+c.awsAccessKeyId)
	}
	if c.awsSecretAccessKey != "" {
		envVars = append(envVars, "AWS_SECRET_ACCESS_KEY="+c.awsSecretAccessKey)
	}
	if c.awsRegion != "" {
		envVars = append(envVars, "AWS_REGION="+c.awsRegion)
	}

	return mountSpec{bin: "mount-s3", args: args, env: envVars}
}

// gcsfuseMountSpec builds the Cloud Storage FUSE invocation. It is not a
// one-to-one translation of mountS3Spec's argv:
//
//   - --allow-delete and --allow-overwrite have no counterpart because gcsfuse
//     permits both by default; passing them is a hard "unknown flag" error.
//   - --implicit-dirs is required for parity. Without it a directory that
//     exists only as an object-name prefix is invisible, while mount-s3 shows it.
//   - --metadata-cache-ttl-secs is pinned to 0 because gcsfuse otherwise caches
//     metadata for 60s, while mount-s3 defaults to strong read-after-write
//     consistency. Inheriting the gcsfuse default would silently hand a box a
//     staleness window it does not have today. Raising this is the first knob to
//     reach for once GCS request volume is measured.
//
// The spec contributes no credential environment of its own; gcsfuse resolves
// Application Default Credentials, which on GCE is the attached instance
// service account. The runner's own environment is still inherited (cmd.Env is
// nil), which is what lets a GOOGLE_APPLICATION_CREDENTIALS path work off-GCE.
// What this does buy is that no secret is placed on the systemd-run argv, where
// /proc/<pid>/cmdline exposes it to every local user.
func gcsfuseMountSpec(bucket string, path string) mountSpec {
	return mountSpec{
		bin: "gcsfuse",
		args: []string{
			"-o", "allow_other",
			"--file-mode", "0666",
			"--dir-mode", "0777",
			"--implicit-dirs",
			"--metadata-cache-ttl-secs", "0",
			bucket, path,
		},
	}
}

// wrapMountCmd turns a spec into the command to run.
//
// On a systemd host the mount is launched in its own transient scope. A FUSE
// daemon started as a plain child of the runner service lands in that service's
// cgroup, so the next `systemctl restart boxlite-runner` kills every mount and
// leaves the boxes bound to them reading a dead mountpoint.
//
// Both branches bind the context so volumeMountTimeout can kill a mount command
// that never returns; the request context alone carries no deadline. The kill
// reaches the foreground process only — a mount tool that has already forked its
// FUSE daemon leaves that daemon behind, which is what the unmount in the
// caller's failure path is for.
func (c *Client) wrapMountCmd(ctx context.Context, spec mountSpec) *exec.Cmd {
	cmd := exec.CommandContext(ctx, spec.bin, spec.args...)
	cmd.Env = spec.env

	if _, err := os.Stat("/run/systemd/system"); err == nil {
		sdArgs := []string{"--scope"}
		for _, env := range spec.env {
			sdArgs = append(sdArgs, "--setenv="+env)
		}
		sdArgs = append(sdArgs, "--", spec.bin)
		sdArgs = append(sdArgs, spec.args...)
		cmd = exec.CommandContext(ctx, "systemd-run", sdArgs...)
	}

	cmd.Stderr = io.Writer(&log.ErrorLogWriter{})
	cmd.Stdout = io.Writer(&log.InfoLogWriter{})

	return cmd
}

func (c *Client) recordBoxVolumeMounts(ctx context.Context, boxID string, mounts []volumeMount) error {
	if boxID == "" || len(mounts) == 0 {
		return nil
	}

	pathsByRoot := make(map[string]struct{})
	for _, mount := range mounts {
		pathsByRoot[normalizeVolumePath(mount.rootPath)] = struct{}{}
	}

	paths := make([]string, 0, len(pathsByRoot))
	for path := range pathsByRoot {
		paths = append(paths, path)
	}

	record := boxVolumeMountRecord{
		BoxID: boxID,
		Paths: paths,
	}

	data, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("failed to marshal volume mount record for box %s: %w", boxID, err)
	}

	dir := getVolumeMountRecordDir()
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create volume mount record directory %s: %w", dir, err)
	}

	path := filepath.Join(dir, boxID+".json")
	if err := os.WriteFile(path, data, 0644); err != nil {
		return fmt.Errorf("failed to write volume mount record %s: %w", path, err)
	}

	c.logger.DebugContext(ctx, "recorded box volume mounts", "box", boxID, "paths", paths)
	return nil
}

func (c *Client) removeBoxVolumeMountRecord(ctx context.Context, boxID string) error {
	if boxID == "" {
		return nil
	}

	path := filepath.Join(getVolumeMountRecordDir(), boxID+".json")
	err := os.Remove(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}

	c.logger.DebugContext(ctx, "removed box volume mount record", "box", boxID)
	return nil
}

func getVolumeMountRecordDir() string {
	return filepath.Join(getVolumeMountBasePath(), volumeMountRecordDir)
}

func normalizeVolumePath(path string) string {
	return strings.TrimRight(filepath.Clean(path), "/")
}

// CleanupOrphanedVolumeMounts removes S3/FUSE volume mounts no longer referenced by known boxes.
func (c *Client) CleanupOrphanedVolumeMounts(ctx context.Context) {
	c.volumeCleanupMutex.Lock()
	defer c.volumeCleanupMutex.Unlock()

	if c.volumeCleanup.interval > 0 && time.Since(c.lastVolumeCleanup) < c.volumeCleanup.interval {
		return
	}
	c.lastVolumeCleanup = time.Now()

	mountDirs, err := filepath.Glob(filepath.Join(getVolumeMountBasePath(), volumeMountPrefix+"*"))
	if err != nil || len(mountDirs) == 0 {
		return
	}

	inUse, err := c.getRecordedVolumeMounts()
	if err != nil {
		c.logger.ErrorContext(ctx, "volume cleanup aborted", "error", err)
		return
	}

	c.logger.InfoContext(ctx, "volume cleanup", "dry-run", c.volumeCleanup.dryRun)

	for _, dir := range mountDirs {
		if inUse[normalizeVolumePath(dir)] {
			continue
		}
		if c.isRecentlyCreated(dir, c.volumeCleanup.exclusionPeriod) {
			continue
		}
		if c.volumeCleanup.dryRun {
			c.logger.InfoContext(ctx, "[DRY-RUN] would clean orphaned volume mount", "path", dir)
			continue
		}
		c.logger.InfoContext(ctx, "cleaning orphaned volume mount", "path", dir)
		c.unmountAndRemoveDir(ctx, dir)
	}
}

func (c *Client) getRecordedVolumeMounts() (map[string]bool, error) {
	inUse := make(map[string]bool)
	recordDir := getVolumeMountRecordDir()

	entries, err := os.ReadDir(recordDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("volume mount record directory %s does not exist; refusing to clean existing mounts without ownership records", recordDir)
		}
		return nil, err
	}

	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}

		data, err := os.ReadFile(filepath.Join(recordDir, entry.Name()))
		if err != nil {
			return nil, err
		}

		var record boxVolumeMountRecord
		if err := json.Unmarshal(data, &record); err != nil {
			return nil, err
		}

		for _, path := range record.Paths {
			cleanPath := normalizeVolumePath(path)
			if strings.HasPrefix(cleanPath, filepath.Join(getVolumeMountBasePath(), volumeMountPrefix)) {
				inUse[cleanPath] = true
			}
		}
	}

	return inUse, nil
}

func (c *Client) unmountAndRemoveDir(ctx context.Context, path string) {
	mountBasePath := getVolumeMountBasePath()
	volumeMountPath := filepath.Join(mountBasePath, volumeMountPrefix)
	cleanPath := normalizeVolumePath(path)
	if !strings.HasPrefix(cleanPath, volumeMountPath) {
		return
	}

	mounted, probeErr := c.isDirectoryMounted(ctx, cleanPath)
	if probeErr != nil {
		// The reclaimer runs again; deleting a path we cannot prove is unmounted
		// would strand the mount under it.
		c.logger.WarnContext(ctx, "skipping volume reclaim, probe inconclusive", "path", cleanPath, "error", probeErr)
		return
	}
	if mounted {
		if err := c.umountPath(ctx, cleanPath); err != nil {
			c.logger.ErrorContext(ctx, "failed to unmount directory", "path", cleanPath, "error", err)
			return
		}
		if err := os.RemoveAll(cleanPath); err != nil {
			c.logger.ErrorContext(ctx, "failed to remove directory", "path", cleanPath, "error", err)
		}
		return
	}

	if c.isDirEmpty(ctx, cleanPath) {
		if err := os.Remove(cleanPath); err != nil {
			c.logger.ErrorContext(ctx, "failed to remove directory", "path", cleanPath, "error", err)
		}
		return
	}

	timestamp := time.Now().Unix()
	garbagePath := filepath.Join(mountBasePath, fmt.Sprintf("garbage-%d-%s", timestamp, strings.TrimPrefix(filepath.Base(cleanPath), volumeMountPrefix)))
	c.logger.DebugContext(ctx, "renaming non-empty volume directory", "path", garbagePath)
	if err := os.Rename(cleanPath, garbagePath); err != nil {
		c.logger.ErrorContext(ctx, "failed to rename directory", "path", cleanPath, "error", err)
	}
}

func (c *Client) isDirEmpty(ctx context.Context, path string) bool {
	entries, err := os.ReadDir(path)
	if err != nil {
		c.logger.ErrorContext(ctx, "failed to read directory", "path", path, "error", err)
		return false
	}
	return len(entries) == 0
}

func (c *Client) isRecentlyCreated(path string, exclusionPeriod time.Duration) bool {
	if exclusionPeriod <= 0 {
		return false
	}
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	return time.Since(info.ModTime()) < exclusionPeriod
}
