// Copyright 2025 Daytona Platforms Inc.
// Copyright 2025-2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"context"
	"encoding/json"
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

type sandboxVolumeMountRecord struct {
	SandboxID string   `json:"sandboxId"`
	Paths     []string `json:"paths"`
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

func (c *Client) ensureVolumeMountsFromMetadata(ctx context.Context, sandboxID string, metadata map[string]string) error {
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

	return c.recordSandboxVolumeMounts(ctx, sandboxID, volumeMounts)
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

	if c.isDirectoryMounted(mountPath) {
		c.logger.DebugContext(ctx, "volume already mounted", "volumeId", volumeId, "mountPath", mountPath)
		return nil
	}

	_, statErr := os.Stat(mountPath)
	dirExisted := statErr == nil

	err := os.MkdirAll(mountPath, 0755)
	if err != nil {
		return fmt.Errorf("failed to create mount directory %s: %s", mountPath, err)
	}

	c.logger.InfoContext(ctx, "mounting S3 volume", "volumeId", volumeId, "mountPath", mountPath)

	cmd := c.getMountCmd(ctx, volumeId, mountPath)
	err = cmd.Run()
	if err != nil {
		if !dirExisted {
			removeErr := os.Remove(mountPath)
			if removeErr != nil {
				c.logger.WarnContext(ctx, "failed to remove mount directory", "path", mountPath, "error", removeErr)
			}
		}
		return fmt.Errorf("failed to mount S3 volume %s to %s: %s", volumeId, mountPath, err)
	}

	err = c.waitForMountReady(ctx, mountPath)
	if err != nil {
		if !dirExisted {
			umountErr := exec.Command("umount", mountPath).Run()
			if umountErr != nil {
				c.logger.WarnContext(ctx, "failed to unmount during cleanup", "path", mountPath, "error", umountErr)
			}
			removeErr := os.Remove(mountPath)
			if removeErr != nil {
				c.logger.WarnContext(ctx, "failed to remove mount directory during cleanup", "path", mountPath, "error", removeErr)
			}
		}
		return fmt.Errorf("mount %s not ready after mounting: %s", mountPath, err)
	}

	c.logger.InfoContext(ctx, "mounted S3 volume", "volumeId", volumeId, "mountPath", mountPath)
	return nil
}

func (c *Client) isDirectoryMounted(path string) bool {
	cmd := exec.Command("mountpoint", path)
	_, err := cmd.Output()

	return err == nil
}

func (c *Client) waitForMountReady(ctx context.Context, path string) error {
	maxAttempts := 50
	sleepDuration := 100 * time.Millisecond

	for i := 0; i < maxAttempts; i++ {
		if !c.isDirectoryMounted(path) {
			return fmt.Errorf("mount disappeared during readiness check")
		}

		_, err := os.Stat(path)
		if err == nil {
			_, err = os.ReadDir(path)
			if err == nil {
				c.logger.InfoContext(ctx, "mount is ready", "path", path, "attempts", i+1)
				return nil
			}
		}

		select {
		case <-ctx.Done():
			return fmt.Errorf("context cancelled while waiting for mount ready: %w", ctx.Err())
		case <-time.After(sleepDuration):
		}
	}

	return fmt.Errorf("mount did not become ready within timeout")
}

func (c *Client) getMountCmd(ctx context.Context, volume string, path string) *exec.Cmd {
	args := []string{"--allow-other", "--allow-delete", "--allow-overwrite", "--file-mode", "0666", "--dir-mode", "0777"}
	args = append(args, volume, path)

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

	cmd := exec.Command("mount-s3", args...)
	cmd.Env = envVars

	_, err := os.Stat("/run/systemd/system")
	if err == nil {
		sdArgs := []string{"--scope"}
		for _, env := range envVars {
			sdArgs = append(sdArgs, "--setenv="+env)
		}
		sdArgs = append(sdArgs, "--", "mount-s3")
		sdArgs = append(sdArgs, args...)
		cmd = exec.CommandContext(ctx, "systemd-run", sdArgs...)
	}

	cmd.Stderr = io.Writer(&log.ErrorLogWriter{})
	cmd.Stdout = io.Writer(&log.InfoLogWriter{})

	return cmd
}

func (c *Client) recordSandboxVolumeMounts(ctx context.Context, sandboxID string, mounts []volumeMount) error {
	if sandboxID == "" || len(mounts) == 0 {
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

	record := sandboxVolumeMountRecord{
		SandboxID: sandboxID,
		Paths:     paths,
	}

	data, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("failed to marshal volume mount record for sandbox %s: %w", sandboxID, err)
	}

	dir := getVolumeMountRecordDir()
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create volume mount record directory %s: %w", dir, err)
	}

	path := filepath.Join(dir, sandboxID+".json")
	if err := os.WriteFile(path, data, 0644); err != nil {
		return fmt.Errorf("failed to write volume mount record %s: %w", path, err)
	}

	c.logger.DebugContext(ctx, "recorded sandbox volume mounts", "sandbox", sandboxID, "paths", paths)
	return nil
}

func (c *Client) removeSandboxVolumeMountRecord(ctx context.Context, sandboxID string) error {
	if sandboxID == "" {
		return nil
	}

	path := filepath.Join(getVolumeMountRecordDir(), sandboxID+".json")
	err := os.Remove(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}

	c.logger.DebugContext(ctx, "removed sandbox volume mount record", "sandbox", sandboxID)
	return nil
}

func getVolumeMountRecordDir() string {
	return filepath.Join(getVolumeMountBasePath(), volumeMountRecordDir)
}

func normalizeVolumePath(path string) string {
	return strings.TrimRight(filepath.Clean(path), "/")
}

// CleanupOrphanedVolumeMounts removes S3/FUSE volume mounts no longer referenced by known sandboxes.
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

		var record sandboxVolumeMountRecord
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

	if c.isDirectoryMounted(cleanPath) {
		if err := exec.Command("umount", cleanPath).Run(); err != nil {
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
