// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package storage

import (
	"context"
)

// ObjectStorageClient defines the interface for object storage operations
type ObjectStorageClient interface {
	GetObject(ctx context.Context, organizationId, hash string) ([]byte, error)
}
