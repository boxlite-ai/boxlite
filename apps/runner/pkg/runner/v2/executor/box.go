/*
 * Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

package executor

import (
	"context"
	"fmt"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/common"
)

func (e *Executor) createBox(ctx context.Context, job *apiclient.Job) (any, error) {
	var createBoxDto dto.CreateBoxDTO
	err := e.parsePayload(job.Payload, &createBoxDto)
	if err != nil {
		return nil, fmt.Errorf("failed to unmarshal payload: %w", err)
	}

	_, daemonVersion, err := e.backend.Create(ctx, createBoxDto)
	if err != nil {
		common.ContainerOperationCount.WithLabelValues("create", string(common.PrometheusOperationStatusFailure)).Inc()
		return nil, common.FormatRecoverableError(err)
	}

	common.ContainerOperationCount.WithLabelValues("create", string(common.PrometheusOperationStatusSuccess)).Inc()

	return dto.StartBoxResponse{
		DaemonVersion: daemonVersion,
	}, nil
}

func (e *Executor) startBox(ctx context.Context, job *apiclient.Job) (any, error) {
	var payload StartBoxPayload
	err := e.parsePayload(job.Payload, &payload)
	if err != nil {
		return nil, fmt.Errorf("failed to unmarshal payload: %w", err)
	}

	daemonVersion, err := e.backend.Start(ctx, job.ResourceId, payload.AuthToken, payload.Metadata)
	if err != nil {
		return nil, common.FormatRecoverableError(err)
	}

	return dto.StartBoxResponse{
		DaemonVersion: daemonVersion,
	}, nil
}

func (e *Executor) stopBox(ctx context.Context, job *apiclient.Job) (any, error) {
	var payload dto.StopBoxDTO
	if job.Payload != nil {
		_ = e.parsePayload(job.Payload, &payload)
	}

	err := e.backend.Stop(ctx, job.ResourceId, payload.Force)
	if err != nil {
		return nil, common.FormatRecoverableError(err)
	}

	return nil, nil
}

// snapshotCancelWait bounds how long a destroy waits for the box's snapshot job
// to let go of the disk before removing it anyway: long enough for the runtime
// to finish an export or restore it has begun, short enough that the destroy
// job itself stays clear of the API's ten-minute stale-job sweep.
const snapshotCancelWait = 5 * time.Minute

func (e *Executor) destroyBox(ctx context.Context, job *apiclient.Job) (any, error) {
	// A delete is allowed mid-snapshot, and it fails the snapshot: cancel the
	// export or restore first, and wait for the runtime to let go of the disk
	// it is reading or replacing before removing it. One still running after
	// snapshotCancelWait races the removal; the cancelled job discards whatever
	// it produces.
	e.boxOps.cancel(job.ResourceId, snapshotCancelWait)

	err := e.backend.Destroy(ctx, job.ResourceId)
	if err != nil {
		common.ContainerOperationCount.WithLabelValues("destroy", string(common.PrometheusOperationStatusFailure)).Inc()
		return nil, common.FormatRecoverableError(err)
	}

	common.ContainerOperationCount.WithLabelValues("destroy", string(common.PrometheusOperationStatusSuccess)).Inc()

	return nil, nil
}
