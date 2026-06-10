// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package services

import (
	"context"
	"log/slog"

	blclient "github.com/boxlite-ai/runner/pkg/boxlite"
	"github.com/boxlite-ai/runner/pkg/models"
)

type BoxService struct {
	boxlite *blclient.Client
	log     *slog.Logger
}

func NewBoxService(logger *slog.Logger, boxlite *blclient.Client) *BoxService {
	return &BoxService{
		log:     logger.With(slog.String("component", "box_service")),
		boxlite: boxlite,
	}
}

func (s *BoxService) GetBoxInfo(ctx context.Context, boxId string) (*models.BoxInfo, error) {
	boxState, err := s.boxlite.GetBoxState(ctx, boxId)
	if err != nil {
		s.log.Warn("Failed to get box state", "boxId", boxId, "error", err)
		return nil, err
	}

	return &models.BoxInfo{
		BoxState: boxState,
	}, nil
}
