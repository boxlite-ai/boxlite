// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 Daytona Platforms Inc.
// Modified and rebranded for BoxLite

package boxlite

import (
	"context"
	"fmt"

	"github.com/daytonaio/runner/pkg/docker/dto"
)

// Resize changes the CPU/memory/disk allocation of a running sandbox.
// TODO: Implement when BoxLite Go SDK supports hot-resize.
func (c *Client) Resize(ctx context.Context, sandboxId string, resizeDto dto.ResizeSandboxDTO) error {
	c.logger.Warn("resize not yet implemented in BoxLite",
		"sandbox", sandboxId,
		"cpu", resizeDto.Cpu,
		"memory", resizeDto.Memory,
		"disk", resizeDto.Disk,
	)
	return fmt.Errorf("resize not yet supported by BoxLite runtime")
}

// RecoverSandbox recovers a sandbox from a storage limit error.
// TODO: Implement when BoxLite supports storage recovery.
func (c *Client) RecoverSandbox(ctx context.Context, sandboxId string, recoverDto dto.RecoverSandboxDTO) error {
	c.logger.Warn("recover sandbox not yet implemented in BoxLite", "sandbox", sandboxId)
	return fmt.Errorf("recover not yet supported by BoxLite runtime")
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
// TODO: Implement when BoxLite Go SDK exposes registry operations.
func (c *Client) PullSnapshot(ctx context.Context, req dto.PullSnapshotRequestDTO) error {
	c.logger.Info("pull snapshot", "snapshot", req.Snapshot)
	// BoxLite auto-pulls during Create, so this is a pre-fetch hint
	return c.PullImage(ctx, req.Snapshot)
}

// GetImageInfo returns metadata about a cached image.
// TODO: Implement when BoxLite Go SDK exposes image inspection.
func (c *Client) GetImageInfo(ctx context.Context, imageName string) (*ImageInfo, error) {
	c.logger.Warn("get image info not yet implemented in BoxLite", "image", imageName)
	return &ImageInfo{}, nil
}

// InspectImageInRegistry inspects an image in a remote registry.
// TODO: Implement registry inspection.
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
