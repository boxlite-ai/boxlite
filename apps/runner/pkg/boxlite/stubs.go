// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 Daytona Platforms Inc.
// Modified and rebranded for BoxLite

package boxlite

import (
	"context"
	"fmt"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/daytonaio/runner/pkg/api/dto"
)

// Resize changes the CPU/memory/disk allocation of a sandbox.
// BoxLite VMs don't support hot-resize, so this stops, removes, and recreates.
func (c *Client) Resize(ctx context.Context, sandboxId string, resizeDto dto.ResizeSandboxDTO) error {
	c.logger.Info("resize sandbox (stop/recreate)", "sandbox", sandboxId)

	bx, err := c.getOrFetchBox(ctx, sandboxId)
	if err != nil {
		return fmt.Errorf("failed to get box for resize: %w", err)
	}

	info, err := bx.Info(ctx)
	if err != nil {
		return fmt.Errorf("failed to get box info for resize: %w", err)
	}

	if err := bx.Stop(ctx); err != nil {
		c.logger.Warn("failed to stop box during resize", "error", err)
	}

	if err := c.Destroy(ctx, sandboxId); err != nil {
		return fmt.Errorf("failed to destroy box during resize: %w", err)
	}

	cpus := info.CPUs
	if resizeDto.Cpu > 0 {
		cpus = int(resizeDto.Cpu)
	}
	memoryMiB := info.MemoryMiB
	if resizeDto.Memory > 0 {
		memoryMiB = int(resizeDto.Memory / (1024 * 1024))
	}

	opts := []boxlite.BoxOption{
		boxlite.WithName(sandboxId),
		boxlite.WithCPUs(cpus),
		boxlite.WithMemory(memoryMiB),
		boxlite.WithAutoRemove(false),
		boxlite.WithDetach(true),
		boxlite.WithNetwork(boxlite.NetworkEnabled()),
	}

	if resizeDto.Disk > 0 {
		opts = append(opts, boxlite.WithDiskSize(resizeDto.Disk/(1024*1024*1024)))
	}

	newBox, err := c.runtime.Create(ctx, info.Image, opts...)
	if err != nil {
		return fmt.Errorf("failed to recreate box during resize: %w", err)
	}

	c.mu.Lock()
	c.boxes[sandboxId] = newBox
	c.mu.Unlock()

	if err := newBox.Start(ctx); err != nil {
		return fmt.Errorf("failed to start resized box: %w", err)
	}

	return nil
}

// RecoverSandbox destroys and recreates a sandbox from its snapshot.
func (c *Client) RecoverSandbox(ctx context.Context, sandboxId string, recoverDto dto.RecoverSandboxDTO) error {
	c.logger.Info("recover sandbox", "sandbox", sandboxId)

	if err := c.Destroy(ctx, sandboxId); err != nil {
		c.logger.Warn("failed to destroy during recover", "error", err)
	}

	snapshot := "alpine:latest"
	if recoverDto.Snapshot != nil {
		snapshot = *recoverDto.Snapshot
	}

	createDto := dto.CreateSandboxDTO{
		Id:              sandboxId,
		Snapshot:        snapshot,
		OsUser:          recoverDto.OsUser,
		CpuQuota:        recoverDto.CpuQuota,
		MemoryQuota:     recoverDto.MemoryQuota,
		StorageQuota:    recoverDto.StorageQuota,
		Env:             recoverDto.Env,
		Volumes:         recoverDto.Volumes,
		NetworkBlockAll: recoverDto.NetworkBlockAll,
		NetworkAllowList: recoverDto.NetworkAllowList,
		FromVolumeId:    recoverDto.FromVolumeId,
		UserId:          recoverDto.UserId,
	}

	_, _, err := c.Create(ctx, createDto)
	return err
}

// CreateBackup creates a backup/snapshot of a running sandbox.
// TODO: Implement when BoxLite Go SDK exposes snapshot operations.
func (c *Client) CreateBackup(ctx context.Context, sandboxId string, backupDto dto.CreateBackupDTO) error {
	c.logger.Warn("create backup not yet implemented in BoxLite", "sandbox", sandboxId)
	return fmt.Errorf("backup not yet supported by BoxLite runtime")
}

// BuildSnapshot builds an image from a Dockerfile.
// TODO: Implement OCI builder integration.
func (c *Client) BuildSnapshot(ctx context.Context, req dto.BuildSnapshotRequestDTO) error {
	c.logger.Warn("build snapshot not yet implemented in BoxLite", "snapshot", req.Snapshot)
	return fmt.Errorf("snapshot build not yet supported by BoxLite runtime")
}

// PullSnapshot pulls a snapshot image from a registry.
func (c *Client) PullSnapshot(ctx context.Context, req dto.PullSnapshotRequestDTO) error {
	c.logger.Info("pulling snapshot", "snapshot", req.Snapshot)
	return c.PullImage(ctx, req.Snapshot)
}

// GetImageInfo returns metadata about a cached image.
func (c *Client) GetImageInfo(ctx context.Context, imageName string) (*ImageInfo, error) {
	img, err := c.GetImageInfoFromCache(ctx, imageName)
	if err != nil {
		return &ImageInfo{}, nil
	}
	var sizeGB float64
	if img.Size != nil {
		sizeGB = float64(*img.Size) / (1024 * 1024 * 1024)
	}
	return &ImageInfo{
		Size: int64(sizeGB * 1024 * 1024 * 1024),
		Hash: img.ID,
	}, nil
}

// InspectImageInRegistry inspects an image in a remote registry.
func (c *Client) InspectImageInRegistry(ctx context.Context, imageName string, registry *dto.RegistryDTO) (*ImageDigest, error) {
	c.logger.Warn("inspect image in registry not yet implemented in BoxLite", "image", imageName)
	return &ImageDigest{}, nil
}

// UpdateNetworkSettings updates the network allowlist/blocklist for a sandbox.
// TODO: Implement when BoxLite Go SDK exposes network configuration.
func (c *Client) UpdateNetworkSettings(ctx context.Context, sandboxId string, settings dto.UpdateNetworkSettingsDTO) error {
	c.logger.Warn("update network settings not yet implemented in BoxLite", "sandbox", sandboxId)
	return nil
}

// TagImage tags a local image with a new name.
func (c *Client) TagImage(ctx context.Context, sourceImage string, targetImage string) error {
	c.logger.Warn("tag image not yet implemented in BoxLite", "source", sourceImage, "target", targetImage)
	return fmt.Errorf("image tagging not yet supported by BoxLite runtime")
}

// PushImage pushes a local image to a remote registry.
func (c *Client) PushImage(ctx context.Context, imageName string, reg *dto.RegistryDTO) error {
	c.logger.Warn("push image not yet implemented in BoxLite", "image", imageName)
	return fmt.Errorf("image push not yet supported by BoxLite runtime")
}

// GetDaemonVersion returns the version of the in-sandbox daemon.
func (c *Client) GetDaemonVersion(ctx context.Context, sandboxId string) (string, error) {
	return "boxlite", nil
}

// CleanupOrphanedVolumeMounts cleans up orphaned volume mounts.
func (c *Client) CleanupOrphanedVolumeMounts(ctx context.Context) {
	// No-op for BoxLite — VMs don't have orphaned mounts
}

// ImageInfo holds metadata about an image.
type ImageInfo struct {
	Size       int64
	Entrypoint []string
	Cmd        []string
	Hash       string
}

// ImageDigest holds a registry image's digest.
type ImageDigest struct {
	Digest string
	Size   int64
}
