// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BoxLite AI (originally Daytona Platforms Inc.
// Modified and rebranded for BoxLite

package boxlite

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/checkpoint"
	"github.com/containerd/errdefs"
)

// RecoverBox destroys and recreates a box.
func (c *Client) RecoverBox(ctx context.Context, boxId string, recoverDto dto.RecoverBoxDTO) error {
	c.logger.Info("recover box", "box", boxId)

	// Check before Destroy: a request that cannot be recreated must not cost
	// the box it was meant to recover.
	createDto := recoverCreateDto(boxId, recoverDto)
	resources, err := validateCreateResources(createDto)
	if err != nil {
		return err
	}
	network, err := networkSpec(createDto)
	if err != nil {
		return err
	}
	if err := validateRecreatableSecrets(createDto.Secrets); err != nil {
		return err
	}

	operation, err := c.checkpointOperations().Lock(ctx, boxId)
	if err != nil {
		return err
	}
	defer operation.Close()
	if err := operation.CheckNoCompleteCreate(); err != nil {
		return err
	}
	if _, err := c.OutboundSnapshot(ctx, boxId); err != nil && !sdk.IsNotFound(err) {
		var failure *sdk.Error
		if errors.As(err, &failure) && failure.Code == sdk.ErrUnsupported {
			return checkpoint.ErrCompleteCreateConflict
		}
		return err
	}
	if err := c.destroy(ctx, boxId, operation); err != nil {
		c.logger.Warn("failed to destroy during recover", "error", err)
	}

	_, _, err = c.create(ctx, createDto, operation, resources, network, nil)
	return err
}

// validateRecreatableSecrets applies the runtime's create-time secret rules that
// a secret stored before them can break. The runtime refuses such a secret when
// recreating the box, which is too late once the old box is destroyed.
// Every secret requires explicit headers; different headers may share a host.
func validateRecreatableSecrets(secrets []dto.SecretDTO) error {
	seenHostHeaders := make(map[[2]string]struct{})
	for _, secret := range secrets {
		if len(secret.Hosts) == 0 {
			return errdefs.ErrInvalidArgument.WithMessage(fmt.Sprintf("secret %q must list at least one host", secret.Name))
		}
		headers := secret.Headers
		if len(headers) == 0 {
			return errdefs.ErrInvalidArgument.WithMessage(fmt.Sprintf("secret %q has no headers; recreate the box with headers", secret.Name))
		}
		if hasSecretHeaderControl(secret.Value) {
			return errdefs.ErrInvalidArgument.WithMessage("secret has an invalid header value")
		}
		ownHeaders := make(map[string]struct{}, len(headers))
		for header, template := range headers {
			normalized := strings.ToLower(header)
			if !secretHeaderToken.MatchString(header) || forbiddenSecretHeader(normalized) {
				return errdefs.ErrInvalidArgument.WithMessage("secret has an invalid header name")
			}
			if _, repeated := ownHeaders[normalized]; repeated {
				return errdefs.ErrInvalidArgument.WithMessage("secret has duplicate header names")
			}
			ownHeaders[normalized] = struct{}{}
			prefix, suffix, found := strings.Cut(template, "{value}")
			if !found || strings.ContainsAny(prefix, "{}") || strings.ContainsAny(suffix, "{}") || hasSecretHeaderControl(template) {
				return errdefs.ErrInvalidArgument.WithMessage("secret has an invalid header template")
			}
		}
		ownHosts := make(map[string]struct{}, len(secret.Hosts))
		for _, host := range secret.Hosts {
			if host == "" {
				return errdefs.ErrInvalidArgument.WithMessage(fmt.Sprintf("secret %q has an empty host", secret.Name))
			}
			normalizedHost := strings.ToLower(host)
			if _, repeated := ownHosts[normalizedHost]; repeated {
				continue
			}
			ownHosts[normalizedHost] = struct{}{}
			for header := range ownHeaders {
				key := [2]string{normalizedHost, header}
				if _, dup := seenHostHeaders[key]; dup {
					return errdefs.ErrInvalidArgument.WithMessage(fmt.Sprintf("multiple secrets configure the same header on host %q", host))
				}
				seenHostHeaders[key] = struct{}{}
			}
		}
	}
	return nil
}

var secretHeaderToken = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")

func forbiddenSecretHeader(header string) bool {
	// Go httputil hopHeaders plus Host and Content-Length, matching Rust.
	switch header {
	case "host", "connection", "proxy-connection", "proxy-authenticate", "proxy-authorization",
		"keep-alive", "te", "trailer", "upgrade", "content-length", "transfer-encoding":
		return true
	}
	return false
}

func hasSecretHeaderControl(value string) bool {
	for i := 0; i < len(value); i++ {
		if (value[i] < 32 && value[i] != '\t') || value[i] == 127 {
			return true
		}
	}
	return false
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
		Privileged:       recoverDto.Privileged,
		Volumes:          recoverDto.Volumes,
		Secrets:          recoverDto.Secrets,
		OutboundEnabled:  recoverDto.OutboundEnabled,
		OutboundAllowNet: recoverDto.OutboundAllowNet,
		FromVolumeId:     recoverDto.FromVolumeId,
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
