// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package services

import (
	"context"
	"log/slog"

	blclient "github.com/boxlite-labs/runner/pkg/boxlite"
	"github.com/boxlite-labs/runner/pkg/cache"
	"github.com/boxlite-labs/runner/pkg/models"
	"github.com/boxlite-labs/runner/pkg/models/enums"
)

type SandboxService struct {
	backupInfoCache *cache.BackupInfoCache
	boxlite         *blclient.Client
	log             *slog.Logger
}

func NewSandboxService(logger *slog.Logger, backupInfoCache *cache.BackupInfoCache, boxlite *blclient.Client) *SandboxService {
	return &SandboxService{
		log:             logger.With(slog.String("component", "sandbox_service")),
		backupInfoCache: backupInfoCache,
		boxlite:         boxlite,
	}
}

func (s *SandboxService) GetSandboxInfo(ctx context.Context, sandboxId string) (*models.SandboxInfo, error) {
	sandboxState, err := s.boxlite.GetSandboxState(ctx, sandboxId)
	if err != nil {
		s.log.Warn("Failed to get sandbox state", "sandboxId", sandboxId, "error", err)
		return nil, err
	}

	backupInfo, err := s.backupInfoCache.Get(ctx, sandboxId)
	if err != nil {
		return &models.SandboxInfo{
			SandboxState: sandboxState,
			BackupState:  enums.BackupStateNone,
		}, nil
	}

	sandboxInfo := &models.SandboxInfo{
		SandboxState:   sandboxState,
		BackupState:    backupInfo.State,
		BackupSnapshot: backupInfo.Snapshot,
	}

	var backupErrReason string
	if backupInfo.Error != nil {
		backupErrReason = backupInfo.Error.Error()
		sandboxInfo.BackupErrorReason = &backupErrReason
	}

	return sandboxInfo, nil
}
