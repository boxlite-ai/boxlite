// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package backend

import (
	"context"

	"github.com/boxlite-ai/runner/pkg/api/dto"
	blclient "github.com/boxlite-ai/runner/pkg/boxlite"
	"github.com/boxlite-ai/runner/pkg/checkpoint"
	"github.com/boxlite-ai/runner/pkg/models"
	"github.com/boxlite-ai/runner/pkg/storage"
)

// BoxliteAdapter wraps the BoxLite Client to implement BoxBackend.
type BoxliteAdapter struct {
	client *blclient.Client
}

func NewBoxliteAdapter(c *blclient.Client) *BoxliteAdapter {
	return &BoxliteAdapter{client: c}
}

// BoxliteClient returns the underlying client for operations not covered by the interface.
func (a *BoxliteAdapter) BoxliteClient() *blclient.Client {
	return a.client
}

func (a *BoxliteAdapter) Create(ctx context.Context, boxDto dto.CreateBoxDTO) (string, string, error) {
	return a.client.Create(ctx, boxDto)
}

func (a *BoxliteAdapter) Start(ctx context.Context, boxId string, authToken *string, metadata map[string]string, nestedVirtualization bool) (string, error) {
	return a.client.Start(ctx, boxId, authToken, metadata, nestedVirtualization)
}

func (a *BoxliteAdapter) Stop(ctx context.Context, boxId string, force bool) error {
	return a.client.Stop(ctx, boxId, force)
}

func (a *BoxliteAdapter) Destroy(ctx context.Context, boxId string) error {
	return a.client.Destroy(ctx, boxId)
}

func (a *BoxliteAdapter) RecoverBox(ctx context.Context, boxId string, recoverDto dto.RecoverBoxDTO) error {
	return a.client.RecoverBox(ctx, boxId, recoverDto)
}

func (a *BoxliteAdapter) UpdateNetworkSettings(ctx context.Context, boxId string, settings dto.UpdateNetworkSettingsDTO) error {
	return a.client.UpdateNetworkSettings(ctx, boxId, settings)
}

func (a *BoxliteAdapter) GetBoxInfo(ctx context.Context, boxId string) (models.BoxInfo, error) {
	return a.client.GetBoxInfo(ctx, boxId)
}

func (a *BoxliteAdapter) Ping(ctx context.Context) error {
	return a.client.Ping(ctx)
}

func (a *BoxliteAdapter) ExportBox(ctx context.Context, boxId, destDir string) (string, error) {
	return a.client.ExportBox(ctx, boxId, destDir)
}

func (a *BoxliteAdapter) ImportBox(ctx context.Context, boxId, archivePath string) error {
	return a.client.ImportBox(ctx, boxId, archivePath)
}

func (a *BoxliteAdapter) ExportCheckpoint(ctx context.Context, boxId, destDir string) (string, string, error) {
	return a.client.ExportCheckpoint(ctx, boxId, destDir)
}

func (a *BoxliteAdapter) RestoreCheckpoint(ctx context.Context, request checkpoint.RestoreRequest, attemptID string, artifacts checkpoint.Artifacts, store storage.ArchiveStore) (checkpoint.RestoreResult, error) {
	return a.client.RestoreCheckpoint(ctx, request, attemptID, artifacts, store)
}

func (a *BoxliteAdapter) RetireCheckpointTarget(ctx context.Context, target string) error {
	return a.client.RetireCheckpointTarget(ctx, target)
}
