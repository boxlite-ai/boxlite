/*
 * Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

package executor

import (
	"context"
	"fmt"

	apiclient "github.com/boxlite-labs/boxlite/libs/api-client-go"
	"github.com/boxlite-labs/runner/pkg/api/dto"
)

func (e *Executor) createBackup(ctx context.Context, job *apiclient.Job) (any, error) {
	var createBackupDto dto.CreateBackupDTO
	err := e.parsePayload(job.Payload, &createBackupDto)
	if err != nil {
		return nil, fmt.Errorf("failed to unmarshal payload: %w", err)
	}

	// TODO: is state cache needed?
	return nil, e.backend.CreateBackup(ctx, job.ResourceId, createBackupDto)
}
