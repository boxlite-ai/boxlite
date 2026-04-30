// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package cache

import (
	"context"
	"time"

	"github.com/boxlite-labs/runner/pkg/models"
	"github.com/boxlite-labs/runner/pkg/models/enums"

	common_cache "github.com/boxlite-labs/common-go/pkg/cache"
)

type BackupInfoCache struct {
	common_cache.ICache[models.BackupInfo]
	retention time.Duration
}

func NewBackupInfoCache(ctx context.Context, retention time.Duration) *BackupInfoCache {
	return &BackupInfoCache{
		ICache:    common_cache.NewMapCache[models.BackupInfo](ctx),
		retention: retention,
	}
}

func (c *BackupInfoCache) SetBackupState(ctx context.Context, sandboxId string, state enums.BackupState, snapshot string, err error) error {
	entry := models.BackupInfo{
		State:    state,
		Snapshot: snapshot,
		Error:    err,
	}

	return c.Set(ctx, sandboxId, entry, c.retention)
}
