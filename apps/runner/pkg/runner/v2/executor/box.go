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

func (e *Executor) destroyBox(ctx context.Context, job *apiclient.Job) (any, error) {
	err := e.backend.Destroy(ctx, job.ResourceId)
	if err != nil {
		common.ContainerOperationCount.WithLabelValues("destroy", string(common.PrometheusOperationStatusFailure)).Inc()
		return nil, common.FormatRecoverableError(err)
	}

	common.ContainerOperationCount.WithLabelValues("destroy", string(common.PrometheusOperationStatusSuccess)).Inc()

	return nil, nil
}

func (e *Executor) updateNetworkSettings(ctx context.Context, job *apiclient.Job) (any, error) {
	var updateNetworkSettingsDto dto.UpdateNetworkSettingsDTO
	err := e.parsePayload(job.Payload, &updateNetworkSettingsDto)
	if err != nil {
		return nil, common.FormatRecoverableError(fmt.Errorf("failed to unmarshal payload: %w", err))
	}

	return nil, e.backend.UpdateNetworkSettings(ctx, job.ResourceId, updateNetworkSettingsDto)
}

func (e *Executor) recoverBox(ctx context.Context, job *apiclient.Job) (any, error) {
	var recoverBoxDto dto.RecoverBoxDTO
	err := e.parsePayload(job.Payload, &recoverBoxDto)
	if err != nil {
		return nil, fmt.Errorf("failed to unmarshal payload: %w", err)
	}

	err = e.backend.RecoverBox(ctx, job.ResourceId, recoverBoxDto)
	if err != nil {
		return nil, common.FormatRecoverableError(err)
	}

	return nil, nil
}

func (e *Executor) resizeBox(ctx context.Context, job *apiclient.Job) (any, error) {
	var resizeBoxDto dto.ResizeBoxDTO
	err := e.parsePayload(job.Payload, &resizeBoxDto)
	if err != nil {
		return nil, fmt.Errorf("failed to unmarshal payload: %w", err)
	}

	err = e.backend.Resize(ctx, job.ResourceId, resizeBoxDto)
	if err != nil {
		common.ContainerOperationCount.WithLabelValues("resize", string(common.PrometheusOperationStatusFailure)).Inc()
		return nil, common.FormatRecoverableError(err)
	}

	common.ContainerOperationCount.WithLabelValues("resize", string(common.PrometheusOperationStatusSuccess)).Inc()

	return nil, nil
}
