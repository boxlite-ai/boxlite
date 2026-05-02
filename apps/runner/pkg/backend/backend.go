// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

// Package backend defines the SandboxBackend interface abstracting
// Docker and BoxLite runtime operations for the executor.
package backend

import (
	"context"

	"github.com/boxlite-labs/runner/pkg/api/dto"
	"github.com/boxlite-labs/runner/pkg/models/enums"
)

// ImageMeta holds common image metadata returned by GetImageInfo.
type ImageMeta struct {
	Size       int64
	Entrypoint []string
	Cmd        []string
	Hash       string
}

// RegistryDigest holds an image digest from a remote registry.
type RegistryDigest struct {
	Digest string
	Size   int64
}

// SandboxBackend abstracts sandbox lifecycle operations.
// Implemented by DockerAdapter and BoxliteAdapter.
type SandboxBackend interface {
	// Sandbox lifecycle — returns (containerId, daemonVersion, error)
	Create(ctx context.Context, sandboxDto dto.CreateSandboxDTO) (string, string, error)
	// Start returns daemonVersion
	Start(ctx context.Context, sandboxId string, authToken *string, metadata map[string]string) (string, error)
	Stop(ctx context.Context, sandboxId string, force bool) error
	Destroy(ctx context.Context, sandboxId string) error
	Resize(ctx context.Context, sandboxId string, resizeDto dto.ResizeSandboxDTO) error
	RecoverSandbox(ctx context.Context, sandboxId string, recoverDto dto.RecoverSandboxDTO) error
	UpdateNetworkSettings(ctx context.Context, sandboxId string, settings dto.UpdateNetworkSettingsDTO) error
	GetSandboxState(ctx context.Context, sandboxId string) (enums.SandboxState, error)

	// Image/snapshot operations
	PullSnapshot(ctx context.Context, req dto.PullSnapshotRequestDTO) error
	BuildSnapshot(ctx context.Context, req dto.BuildSnapshotRequestDTO) error
	RemoveImage(ctx context.Context, imageName string, force bool) error
	GetImageInfo(ctx context.Context, imageName string) (*ImageMeta, error)
	InspectImageInRegistry(ctx context.Context, imageName string, registry *dto.RegistryDTO) (*RegistryDigest, error)

	// Backup
	CreateBackup(ctx context.Context, sandboxId string, backupDto dto.CreateBackupDTO) error

	// Health
	Ping(ctx context.Context) error
}
