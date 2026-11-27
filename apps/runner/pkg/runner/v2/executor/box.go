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
	"github.com/boxlite-ai/runner/pkg/backend"
	"github.com/boxlite-ai/runner/pkg/common"
)

func (e *Executor) createBox(ctx context.Context, job *apiclient.Job) (any, error) {
	// Terminal status callbacks need only the job ID. Drop the wire payload on
	// every exit, including malformed credentials, without retaining its token.
	defer func() { job.Payload = nil }()
	var payload createBoxJobPayload
	err := e.parsePayload(job.Payload, &payload)
	if err != nil {
		// JSON/type errors can include credential or policy contents.
		return nil, fmt.Errorf("invalid create payload")
	}
	if err := validateCreateSecrets(job, payload); err != nil {
		return nil, err
	}
	createBoxDto := payload.CreateBoxDTO
	if payload.SecretCredential != nil {
		if err := e.resolveCreateSecrets(ctx, &createBoxDto, payload.SecretCredential.Token); err != nil {
			return nil, err
		}
	}

	_, daemonVersion, err := e.backend.Create(ctx, createBoxDto)
	if err != nil {
		common.ContainerOperationCount.WithLabelValues("create", string(common.PrometheusOperationStatusFailure)).Inc()
		if payload.SecretCredential != nil {
			return nil, fmt.Errorf("box creation failed after secret credential processing")
		}
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
	if restorer, ok := e.backend.(backend.CheckpointRestorer); ok {
		if err := restorer.RetireCheckpointTarget(ctx, job.ResourceId); err != nil {
			return nil, err
		}
	}
	err := e.destroyIfPresent(ctx, job.ResourceId)
	if err != nil {
		common.ContainerOperationCount.WithLabelValues("destroy", string(common.PrometheusOperationStatusFailure)).Inc()
		return nil, common.FormatRecoverableError(err)
	}

	common.ContainerOperationCount.WithLabelValues("destroy", string(common.PrometheusOperationStatusSuccess)).Inc()

	return nil, nil
}
