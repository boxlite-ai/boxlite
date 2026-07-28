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
	"github.com/containerd/errdefs"
)

func (e *Executor) createBox(ctx context.Context, job *apiclient.Job) (any, error) {
	var createBoxDto dto.CreateBoxDTO
	err := e.parsePayload(job.Payload, &createBoxDto)
	if err != nil {
		return nil, fmt.Errorf("failed to unmarshal payload: %w", err)
	}
	runtimeGeneration, err := e.runtimeGeneration(job)
	if err != nil {
		return nil, err
	}
	prepared, err := e.generations.PrepareStart(job.ResourceId, runtimeGeneration)
	if err != nil {
		return nil, err
	}
	if !prepared {
		return nil, fmt.Errorf("stale runtime generation %d for box %s", runtimeGeneration, job.ResourceId)
	}

	_, daemonVersion, err := e.backend.Create(ctx, createBoxDto)
	if err != nil {
		common.ContainerOperationCount.WithLabelValues("create", string(common.PrometheusOperationStatusFailure)).Inc()
		return nil, common.FormatRecoverableError(err)
	}

	common.ContainerOperationCount.WithLabelValues("create", string(common.PrometheusOperationStatusSuccess)).Inc()

	return RuntimeStartedResult{
		DaemonVersion:     daemonVersion,
		RunnerEpoch:       e.runnerEpoch,
		RuntimeGeneration: runtimeGeneration,
	}, nil
}

func (e *Executor) startBox(ctx context.Context, job *apiclient.Job) (any, error) {
	var payload StartBoxPayload
	err := e.parsePayload(job.Payload, &payload)
	if err != nil {
		return nil, fmt.Errorf("failed to unmarshal payload: %w", err)
	}
	if payload.RuntimeGeneration <= 0 {
		return nil, fmt.Errorf("runtimeGeneration must be positive")
	}
	prepared, err := e.generations.PrepareStart(job.ResourceId, payload.RuntimeGeneration)
	if err != nil {
		return nil, err
	}
	if !prepared {
		return nil, fmt.Errorf("stale runtime generation %d for box %s", payload.RuntimeGeneration, job.ResourceId)
	}

	daemonVersion, err := e.backend.Start(ctx, job.ResourceId, payload.AuthToken, payload.Metadata)
	if err != nil {
		return nil, common.FormatRecoverableError(err)
	}

	return RuntimeStartedResult{
		DaemonVersion:     daemonVersion,
		RunnerEpoch:       e.runnerEpoch,
		RuntimeGeneration: payload.RuntimeGeneration,
	}, nil
}

func (e *Executor) stopBox(ctx context.Context, job *apiclient.Job) (any, error) {
	var payload dto.StopBoxDTO
	if job.Payload != nil {
		_ = e.parsePayload(job.Payload, &payload)
	}
	generation, err := e.runtimeGenerationPayload(job)
	if err != nil {
		return nil, err
	}
	prepared, err := e.generations.PrepareStop(
		job.ResourceId,
		generation.RuntimeGeneration,
		generation.PreviousRuntimeGeneration,
	)
	if err != nil {
		return nil, err
	}
	if !prepared {
		return nil, nil
	}

	err = e.backend.Stop(ctx, job.ResourceId, payload.Force)
	if err != nil {
		return nil, common.FormatRecoverableError(err)
	}
	if err := e.generations.MarkStopped(job.ResourceId, generation.RuntimeGeneration); err != nil {
		return nil, err
	}

	return nil, nil
}

func (e *Executor) stopOrphanRuntime(ctx context.Context, job *apiclient.Job) (any, error) {
	var payload struct {
		Force bool `json:"force,omitempty"`
		RuntimeGenerationPayload
	}
	if err := e.parsePayload(job.Payload, &payload); err != nil {
		return nil, err
	}
	if payload.RuntimeGeneration <= 0 {
		return nil, fmt.Errorf("runtimeGeneration must be positive")
	}
	if e.generations.Generation(job.ResourceId) != payload.RuntimeGeneration {
		return nil, nil
	}
	if err := e.backend.Stop(ctx, job.ResourceId, payload.Force); err != nil {
		return nil, common.FormatRecoverableError(err)
	}
	if err := e.generations.MarkStopped(job.ResourceId, payload.RuntimeGeneration); err != nil {
		return nil, err
	}
	return nil, nil
}

func (e *Executor) destroyBox(ctx context.Context, job *apiclient.Job) (any, error) {
	generation, err := e.runtimeGenerationPayload(job)
	if err != nil {
		return nil, err
	}
	prepared, err := e.generations.PrepareStop(
		job.ResourceId,
		generation.RuntimeGeneration,
		generation.PreviousRuntimeGeneration,
	)
	if err != nil {
		return nil, err
	}
	if !prepared {
		return nil, nil
	}
	err = e.backend.Destroy(ctx, job.ResourceId)
	if err != nil {
		common.ContainerOperationCount.WithLabelValues("destroy", string(common.PrometheusOperationStatusFailure)).Inc()
		return nil, common.FormatRecoverableError(err)
	}

	common.ContainerOperationCount.WithLabelValues("destroy", string(common.PrometheusOperationStatusSuccess)).Inc()
	if err := e.generations.MarkStopped(job.ResourceId, generation.RuntimeGeneration); err != nil {
		return nil, err
	}

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
	runtimeGeneration, err := e.runtimeGeneration(job)
	if err != nil {
		return nil, err
	}
	prepared, err := e.generations.PrepareStart(job.ResourceId, runtimeGeneration)
	if err != nil {
		return nil, err
	}
	if !prepared {
		return nil, fmt.Errorf("stale runtime generation %d for box %s", runtimeGeneration, job.ResourceId)
	}

	err = e.backend.RecoverBox(ctx, job.ResourceId, recoverBoxDto)
	if err != nil {
		return nil, common.FormatRecoverableError(err)
	}
	return RuntimeStartedResult{
		RunnerEpoch:       e.runnerEpoch,
		RuntimeGeneration: runtimeGeneration,
	}, nil
}

// resizeBox remains as a compatibility sink for jobs created by older API
// deployments. It must fail before touching the box.
func (e *Executor) resizeBox(_ context.Context, _ *apiclient.Job) (any, error) {
	return nil, errdefs.ErrNotImplemented.WithMessage("box resource resize is not supported")
}

func (e *Executor) runtimeGeneration(job *apiclient.Job) (int64, error) {
	payload, err := e.runtimeGenerationPayload(job)
	if err != nil {
		return 0, err
	}
	return payload.RuntimeGeneration, nil
}

func (e *Executor) runtimeGenerationPayload(job *apiclient.Job) (RuntimeGenerationPayload, error) {
	var payload RuntimeGenerationPayload
	if err := e.parsePayload(job.Payload, &payload); err != nil {
		return RuntimeGenerationPayload{}, err
	}
	if payload.RuntimeGeneration <= 0 {
		return RuntimeGenerationPayload{}, fmt.Errorf("runtimeGeneration must be positive")
	}
	return payload, nil
}
