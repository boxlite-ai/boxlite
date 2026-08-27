// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BoxLite AI (originally Daytona Platforms Inc.
// Modified and rebranded for BoxLite

package boxlite

import (
	"context"

	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/containerd/errdefs"
)

// RecoverBox destroys and recreates a box.
func (c *Client) RecoverBox(ctx context.Context, boxId string, recoverDto dto.RecoverBoxDTO) error {
	c.logger.Info("recover box", "box", boxId)

	if err := c.Destroy(ctx, boxId); err != nil {
		c.logger.Warn("failed to destroy during recover", "error", err)
	}

	_, _, err := c.Create(ctx, recoverCreateDto(boxId, recoverDto))
	return err
}

// recoverCreateDto rebuilds the create request RecoverBox hands to Create by
// hand. Extracted as a pure function so the copy is testable without a live
// runtime: a field not copied here is silently lost on a recovered box.
func recoverCreateDto(boxId string, recoverDto dto.RecoverBoxDTO) dto.CreateBoxDTO {
	return dto.CreateBoxDTO{
		Id:               boxId,
		Image:            "alpine:latest",
		OsUser:           recoverDto.OsUser,
		CpuQuota:         recoverDto.CpuQuota,
		GpuQuota:         recoverDto.GpuQuota,
		MemoryQuota:      recoverDto.MemoryQuota,
		StorageQuota:     recoverDto.StorageQuota,
		Env:              recoverDto.Env,
		Volumes:          recoverDto.Volumes,
		Secrets:          recoverDto.Secrets,
		NetworkBlockAll:  recoverDto.NetworkBlockAll,
		NetworkAllowList: recoverDto.NetworkAllowList,
		FromVolumeId:     recoverDto.FromVolumeId,
	}
}

// UpdateNetworkSettings updates the network allowlist/blocklist for a box.
// TODO: Implement when BoxLite Go SDK exposes network configuration.
func (c *Client) UpdateNetworkSettings(ctx context.Context, boxId string, settings dto.UpdateNetworkSettingsDTO) error {
	c.logger.Warn("update network settings not yet implemented in BoxLite", "box", boxId)
	return errdefs.ErrNotImplemented.WithMessage("live network settings update is not supported by the BoxLite Go SDK")
}

// GetDaemonVersion returns the runtime version for the legacy API field.
func (c *Client) GetDaemonVersion(ctx context.Context, boxId string) (string, error) {
	return "boxlite", nil
}
