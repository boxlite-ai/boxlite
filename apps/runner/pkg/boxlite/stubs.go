// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BoxLite AI (originally Daytona Platforms Inc.
// Modified and rebranded for BoxLite

package boxlite

import (
	"context"
	"fmt"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/containerd/errdefs"
)

// Resize changes the CPU/memory/disk allocation of a box.
// BoxLite VMs don't support hot-resize, so this stops, removes, and recreates.
func (c *Client) Resize(ctx context.Context, boxId string, resizeDto dto.ResizeBoxDTO) error {
	c.logger.Info("resize box (stop/recreate)", "box", boxId)

	bx, err := c.getOrFetchBox(ctx, boxId)
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

	if err := c.Destroy(ctx, boxId); err != nil {
		return fmt.Errorf("failed to destroy box during resize: %w", err)
	}

	// API sends cores / GB / GB as small integers (see apps/api ResizeBoxDto).
	cpus := info.CPUs
	if resizeDto.Cpu > 0 {
		cpus = int(resizeDto.Cpu)
	}
	memoryMiB := info.MemoryMiB
	if resizeDto.Memory > 0 {
		memoryMiB = int(resizeDto.Memory * 1024)
	}

	opts := []boxlite.BoxOption{
		boxlite.WithName(boxId),
		boxlite.WithCPUs(cpus),
		boxlite.WithMemory(memoryMiB),
		boxlite.WithAutoRemove(false),
		boxlite.WithDetach(true),
		boxlite.WithNetwork(boxlite.NetworkSpec{Mode: boxlite.NetworkModeEnabled}),
	}

	toolboxHostPort, err := c.reserveToolboxHostPort(ctx, boxId)
	if err != nil {
		return fmt.Errorf("failed to reserve toolbox port during resize: %w", err)
	}
	opts = append(opts, boxlite.WithPort(ToolboxGuestPort, toolboxHostPort))

	if resizeDto.Disk > 0 {
		opts = append(opts, boxlite.WithDiskSize(int(resizeDto.Disk)))
	}

	newBox, err := c.runtime.Create(ctx, info.Image, opts...)
	if err != nil {
		if cleanupErr := c.removeToolboxPortRecord(ctx, boxId); cleanupErr != nil {
			c.logger.Warn("failed to remove toolbox port record after resize create failure", "box", boxId, "error", cleanupErr)
		}
		return fmt.Errorf("failed to recreate box during resize: %w", err)
	}

	c.mu.Lock()
	c.boxes[boxId] = newBox
	c.mu.Unlock()

	if err := newBox.Start(ctx); err != nil {
		return fmt.Errorf("failed to start resized box: %w", err)
	}

	return nil
}

// RecoverBox destroys and recreates a box.
func (c *Client) RecoverBox(ctx context.Context, boxId string, recoverDto dto.RecoverBoxDTO) error {
	c.logger.Info("recover box", "box", boxId)

	if err := c.Destroy(ctx, boxId); err != nil {
		c.logger.Warn("failed to destroy during recover", "error", err)
	}

	createDto := dto.CreateBoxDTO{
		Id:               boxId,
		ArtifactRef:      "alpine:latest",
		OsUser:           recoverDto.OsUser,
		CpuQuota:         recoverDto.CpuQuota,
		MemoryQuota:      recoverDto.MemoryQuota,
		StorageQuota:     recoverDto.StorageQuota,
		Env:              recoverDto.Env,
		Volumes:          recoverDto.Volumes,
		NetworkBlockAll:  recoverDto.NetworkBlockAll,
		NetworkAllowList: recoverDto.NetworkAllowList,
		FromVolumeId:     recoverDto.FromVolumeId,
		UserId:           recoverDto.UserId,
	}

	_, _, err := c.Create(ctx, createDto)
	return err
}

// UpdateNetworkSettings updates the network allowlist/blocklist for a box.
// TODO: Implement when BoxLite Go SDK exposes network configuration.
func (c *Client) UpdateNetworkSettings(ctx context.Context, boxId string, settings dto.UpdateNetworkSettingsDTO) error {
	c.logger.Warn("update network settings not yet implemented in BoxLite", "box", boxId)
	return errdefs.ErrNotImplemented.WithMessage("live network settings update is not supported by the BoxLite Go SDK")
}

// GetDaemonVersion returns the version of the in-box daemon.
func (c *Client) GetDaemonVersion(ctx context.Context, boxId string) (string, error) {
	return "boxlite", nil
}
