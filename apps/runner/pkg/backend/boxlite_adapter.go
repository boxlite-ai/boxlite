// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package backend

import (
	"context"

	"github.com/boxlite-ai/runner/pkg/api/dto"
	blclient "github.com/boxlite-ai/runner/pkg/boxlite"
	"github.com/boxlite-ai/runner/pkg/models/enums"
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

func (a *BoxliteAdapter) Start(ctx context.Context, boxId string, authToken *string, metadata map[string]string) (string, error) {
	return a.client.Start(ctx, boxId, authToken, metadata)
}

func (a *BoxliteAdapter) Stop(ctx context.Context, boxId string, force bool) error {
	return a.client.Stop(ctx, boxId, force)
}

func (a *BoxliteAdapter) Destroy(ctx context.Context, boxId string) error {
	return a.client.Destroy(ctx, boxId)
}

func (a *BoxliteAdapter) Resize(ctx context.Context, boxId string, resizeDto dto.ResizeBoxDTO) error {
	return a.client.Resize(ctx, boxId, resizeDto)
}

func (a *BoxliteAdapter) RecoverBox(ctx context.Context, boxId string, recoverDto dto.RecoverBoxDTO) error {
	return a.client.RecoverBox(ctx, boxId, recoverDto)
}

func (a *BoxliteAdapter) UpdateNetworkSettings(ctx context.Context, boxId string, settings dto.UpdateNetworkSettingsDTO) error {
	return a.client.UpdateNetworkSettings(ctx, boxId, settings)
}

func (a *BoxliteAdapter) GetBoxState(ctx context.Context, boxId string) (enums.BoxState, error) {
	return a.client.GetBoxState(ctx, boxId)
}

func (a *BoxliteAdapter) Ping(ctx context.Context) error {
	return a.client.Ping(ctx)
}
