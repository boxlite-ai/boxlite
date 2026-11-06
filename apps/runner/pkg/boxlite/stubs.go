// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BoxLite AI (originally Daytona Platforms Inc.
// Modified and rebranded for BoxLite

package boxlite

import (
	"context"
	"fmt"
	"strings"

	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/containerd/errdefs"
)

// RecoverBox destroys and recreates a box.
func (c *Client) RecoverBox(ctx context.Context, boxId string, recoverDto dto.RecoverBoxDTO) error {
	c.logger.Info("recover box", "box", boxId)

	// Check before Destroy: a request that cannot be recreated must not cost
	// the box it was meant to recover.
	createDto := recoverCreateDto(boxId, recoverDto)
	if createDto.NestedVirtualization && !c.nestedVirtualizationAllowed {
		return errdefs.ErrInvalidArgument.WithMessage("nested virtualization requires BOXLITE_EXPERIMENTAL=nested-virtualization on the Runner")
	}
	if _, err := networkSpec(createDto); err != nil {
		return err
	}
	if err := validateRecreatableSecrets(createDto.Secrets); err != nil {
		return err
	}

	if err := c.Destroy(ctx, boxId); err != nil {
		c.logger.Warn("failed to destroy during recover", "error", err)
	}

	_, _, err := c.Create(ctx, createDto)
	return err
}

// validateRecreatableSecrets applies the runtime's create-time secret rules that
// a secret stored before them can break. The runtime refuses such a secret when
// recreating the box, which is too late once the old box is destroyed. Runner
// secrets carry no header, so each one writes the default header.
func validateRecreatableSecrets(secrets []dto.SecretDTO) error {
	seenHosts := make(map[string]struct{})
	for _, secret := range secrets {
		if len(secret.Hosts) == 0 {
			return errdefs.ErrInvalidArgument.WithMessage(fmt.Sprintf("secret %q must list at least one host", secret.Name))
		}
		ownHosts := make(map[string]struct{}, len(secret.Hosts))
		for _, host := range secret.Hosts {
			if host == "" {
				return errdefs.ErrInvalidArgument.WithMessage(fmt.Sprintf("secret %q has an empty host", secret.Name))
			}
			key := strings.ToLower(host)
			if _, repeated := ownHosts[key]; repeated {
				continue
			}
			ownHosts[key] = struct{}{}
			if _, dup := seenHosts[key]; dup {
				return errdefs.ErrInvalidArgument.WithMessage(fmt.Sprintf("multiple secrets configure the same header on host %q", host))
			}
			seenHosts[key] = struct{}{}
		}
	}
	return nil
}

// recoverCreateDto rebuilds the create request RecoverBox hands to Create by
// hand. Extracted as a pure function so the copy is testable without a live
// runtime: a field not copied here is silently lost on a recovered box.
func recoverCreateDto(boxId string, recoverDto dto.RecoverBoxDTO) dto.CreateBoxDTO {
	return dto.CreateBoxDTO{
		NestedVirtualization: recoverDto.NestedVirtualization,
		Id:                   boxId,
		Image:                "alpine:latest",
		OsUser:               recoverDto.OsUser,
		CpuQuota:             recoverDto.CpuQuota,
		GpuQuota:             recoverDto.GpuQuota,
		MemoryQuota:          recoverDto.MemoryQuota,
		StorageQuota:         recoverDto.StorageQuota,
		Env:                  recoverDto.Env,
		Privileged:           recoverDto.Privileged,
		Volumes:              recoverDto.Volumes,
		Secrets:              recoverDto.Secrets,
		OutboundEnabled:      recoverDto.OutboundEnabled,
		OutboundAllowNet:     recoverDto.OutboundAllowNet,
		FromVolumeId:         recoverDto.FromVolumeId,
	}
}

// UpdateNetworkSettings is the unsupported legacy partial allowlist/blocklist API.
// Full outbound replacements use SetOutboundNetwork.
func (c *Client) UpdateNetworkSettings(ctx context.Context, boxId string, settings dto.UpdateNetworkSettingsDTO) error {
	c.logger.Warn("update network settings not yet implemented in BoxLite", "box", boxId)
	return errdefs.ErrNotImplemented.WithMessage("legacy network patches are unsupported; use the outbound policy update")
}

// GetDaemonVersion returns the runtime version for the legacy API field.
func (c *Client) GetDaemonVersion(ctx context.Context, boxId string) (string, error) {
	return "boxlite", nil
}
