// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

// Package backend defines the BoxBackend interface abstracting
// Docker and BoxLite runtime operations for the executor.
package backend

import (
	"context"

	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/models/enums"
)

// BoxBackend abstracts box lifecycle operations.
// Implemented by DockerAdapter and BoxliteAdapter.
type BoxBackend interface {
	// Box lifecycle — returns (containerId, daemonVersion, error)
	Create(ctx context.Context, boxDto dto.CreateBoxDTO) (string, string, error)
	// Start returns daemonVersion
	Start(ctx context.Context, boxId string, authToken *string, metadata map[string]string) (string, error)
	Stop(ctx context.Context, boxId string, force bool) error
	Destroy(ctx context.Context, boxId string) error
	Resize(ctx context.Context, boxId string, resizeDto dto.ResizeBoxDTO) error
	RecoverBox(ctx context.Context, boxId string, recoverDto dto.RecoverBoxDTO) error
	UpdateNetworkSettings(ctx context.Context, boxId string, settings dto.UpdateNetworkSettingsDTO) error
	GetBoxState(ctx context.Context, boxId string) (enums.BoxState, error)

	// Health
	Ping(ctx context.Context) error
}
