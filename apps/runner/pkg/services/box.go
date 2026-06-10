// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package services

import (
	"context"
	"log/slog"

	blclient "github.com/boxlite-ai/runner/pkg/boxlite"
	"github.com/boxlite-ai/runner/pkg/cache"
	"github.com/boxlite-ai/runner/pkg/models"
	"github.com/boxlite-ai/runner/pkg/models/enums"
)

type BoxService struct {
	backupInfoCache *cache.BackupInfoCache
	boxlite         *blclient.Client
	log             *slog.Logger
}

func NewBoxService(logger *slog.Logger, backupInfoCache *cache.BackupInfoCache, boxlite *blclient.Client) *BoxService {
	return &BoxService{
		log:             logger.With(slog.String("component", "box_service")),
		backupInfoCache: backupInfoCache,
		boxlite:         boxlite,
	}
}

func (s *BoxService) GetBoxInfo(ctx context.Context, boxId string) (*models.BoxInfo, error) {
	boxState, err := s.boxlite.GetBoxState(ctx, boxId)
	if err != nil {
		s.log.Warn("Failed to get box state", "boxId", boxId, "error", err)
		return nil, err
	}

	backupInfo, err := s.backupInfoCache.Get(ctx, boxId)
	if err != nil {
		return &models.BoxInfo{
			BoxState:    boxState,
			BackupState: enums.BackupStateNone,
		}, nil
	}

	boxInfo := &models.BoxInfo{
		BoxState:       boxState,
		BackupState:    backupInfo.State,
		BackupSnapshot: backupInfo.Snapshot,
	}

	var backupErrReason string
	if backupInfo.Error != nil {
		backupErrReason = backupInfo.Error.Error()
		boxInfo.BackupErrorReason = &backupErrReason
	}

	return boxInfo, nil
}
