// Copyright BoxLite AI (originally Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package cache

import (
	"context"
	"time"

	common_cache "github.com/boxlite-ai/common-go/pkg/cache"
)

type ArtifactErrorCache struct {
	common_cache.ICache[string]
	retention time.Duration
}

func NewArtifactErrorCache(ctx context.Context, retention time.Duration) *ArtifactErrorCache {
	return &ArtifactErrorCache{
		ICache:    common_cache.NewMapCache[string](ctx),
		retention: retention,
	}
}

func (c *ArtifactErrorCache) SetError(ctx context.Context, artifactRef string, errReason string) error {
	return c.Set(ctx, artifactRef, errReason, c.retention)
}

func (c *ArtifactErrorCache) GetError(ctx context.Context, artifactRef string) (*string, error) {
	return c.Get(ctx, artifactRef)
}

func (c *ArtifactErrorCache) RemoveError(ctx context.Context, artifactRef string) error {
	return c.Delete(ctx, artifactRef)
}
