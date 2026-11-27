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
	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/internal/timing"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/backend"
	"github.com/boxlite-ai/runner/pkg/common"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

func (e *Executor) createBox(ctx context.Context, job *apiclient.Job) (any, error) {
	ctx, prepareSpan := otel.Tracer("runner").Start(ctx, "job.prepare",
		trace.WithAttributes(attribute.String("box_id", job.GetResourceId())))
	var createBoxDto dto.CreateBoxDTO
	err := e.parsePayload(job.Payload, &createBoxDto)
	if err != nil {
		prepareSpan.RecordError(err)
		prepareSpan.SetStatus(codes.Error, "failed to unmarshal CREATE_BOX payload")
		prepareSpan.End()
		return nil, fmt.Errorf("failed to unmarshal payload: %w", err)
	}
	prepareSpan.End()

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

func (e *Executor) destroyBox(ctx context.Context, job *apiclient.Job) (any, error) {
	started := time.Now()
	ids := timing.IDs{BoxID: job.GetResourceId(), JobID: job.GetId()}
	if restorer, ok := e.backend.(backend.CheckpointRestorer); ok {
		if err := restorer.RetireCheckpointTarget(ctx, job.ResourceId); err != nil {
			timing.Emit("destroy", "destroy.dispatched", timing.Error, started, ids)
			timing.Emit("destroy", "destroy.runtime", timing.Skipped, time.Now(), ids)
			timing.Emit("destroy", "destroy.client", timing.Skipped, time.Now(), ids)
			return nil, err
		}
	}
	timing.Emit("destroy", "destroy.dispatched", timing.OK, started, ids)
	err := e.backend.Destroy(ctx, job.ResourceId)
	if boxlite.IsNotFound(err) {
		timing.MarkDestroySkipped(ctx)
		err = nil
	}
	if err != nil {
		common.ContainerOperationCount.WithLabelValues("destroy", string(common.PrometheusOperationStatusFailure)).Inc()
		return nil, common.FormatRecoverableError(err)
	}

	common.ContainerOperationCount.WithLabelValues("destroy", string(common.PrometheusOperationStatusSuccess)).Inc()

	return nil, nil
}
