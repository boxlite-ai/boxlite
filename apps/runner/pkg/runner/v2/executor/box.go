/*
 * Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

package executor

import (
	"context"
	"fmt"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/common"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

func (e *Executor) createBox(ctx context.Context, job *apiclient.Job) (any, error) {
	ctx, span := e.startRuntimeSpan(ctx, "create", job)
	defer span.End()
	var createBoxDto dto.CreateBoxDTO
	err := e.parsePayload(job.Payload, &createBoxDto)
	if err != nil {
		e.recordRuntimeError(span, err)
		return nil, fmt.Errorf("failed to unmarshal payload: %w", err)
	}

	_, daemonVersion, err := e.backend.Create(ctx, createBoxDto)
	if err != nil {
		e.recordRuntimeError(span, err)
		common.ContainerOperationCount.WithLabelValues("create", string(common.PrometheusOperationStatusFailure)).Inc()
		return nil, common.FormatRecoverableError(err)
	}

	common.ContainerOperationCount.WithLabelValues("create", string(common.PrometheusOperationStatusSuccess)).Inc()

	return dto.StartBoxResponse{
		DaemonVersion: daemonVersion,
	}, nil
}

func (e *Executor) startBox(ctx context.Context, job *apiclient.Job) (any, error) {
	ctx, span := e.startRuntimeSpan(ctx, "start", job)
	defer span.End()
	var payload StartBoxPayload
	err := e.parsePayload(job.Payload, &payload)
	if err != nil {
		e.recordRuntimeError(span, err)
		return nil, fmt.Errorf("failed to unmarshal payload: %w", err)
	}

	daemonVersion, err := e.backend.Start(ctx, job.ResourceId, payload.AuthToken, payload.Metadata)
	if err != nil {
		e.recordRuntimeError(span, err)
		return nil, common.FormatRecoverableError(err)
	}

	return dto.StartBoxResponse{
		DaemonVersion: daemonVersion,
	}, nil
}

func (e *Executor) stopBox(ctx context.Context, job *apiclient.Job) (any, error) {
	ctx, span := e.startRuntimeSpan(ctx, "stop", job)
	defer span.End()
	var payload dto.StopBoxDTO
	if job.Payload != nil {
		_ = e.parsePayload(job.Payload, &payload)
	}

	err := e.backend.Stop(ctx, job.ResourceId, payload.Force)
	if err != nil {
		e.recordRuntimeError(span, err)
		return nil, common.FormatRecoverableError(err)
	}

	return nil, nil
}

func (e *Executor) destroyBox(ctx context.Context, job *apiclient.Job) (any, error) {
	ctx, span := e.startRuntimeSpan(ctx, "destroy", job)
	defer span.End()
	err := e.backend.Destroy(ctx, job.ResourceId)
	if err != nil {
		e.recordRuntimeError(span, err)
		common.ContainerOperationCount.WithLabelValues("destroy", string(common.PrometheusOperationStatusFailure)).Inc()
		return nil, common.FormatRecoverableError(err)
	}

	common.ContainerOperationCount.WithLabelValues("destroy", string(common.PrometheusOperationStatusSuccess)).Inc()

	return nil, nil
}

func (e *Executor) startRuntimeSpan(ctx context.Context, operation string, job *apiclient.Job) (context.Context, trace.Span) {
	telemetry := e.getJobTelemetryContext(job)
	attributes := []attribute.KeyValue{
		attribute.String("boxlite.source", "runtime-wrapper"),
		attribute.String("boxlite.job.id", job.GetId()),
		attribute.String("boxlite.box.id", job.GetResourceId()),
	}
	if telemetry.OrganizationID != "" {
		attributes = append(attributes, attribute.String("boxlite.organization.id", telemetry.OrganizationID))
	}
	if telemetry.RunnerID != "" {
		attributes = append(attributes, attribute.String("boxlite.runner.id", telemetry.RunnerID))
	}
	return otel.Tracer("runner/boxlite-runtime").Start(
		ctx,
		"boxlite.runtime."+operation,
		trace.WithAttributes(attributes...),
	)
}

func (e *Executor) recordRuntimeError(span trace.Span, err error) {
	span.RecordError(err)
	span.SetStatus(codes.Error, "runtime operation failed")
}
