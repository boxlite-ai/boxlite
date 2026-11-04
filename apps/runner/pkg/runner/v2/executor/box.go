/*
 * Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

package executor

import (
	"context"
	"fmt"
	"path/filepath"

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
	var snapshot struct {
		ArchiveURI string `json:"snapshotArchiveUri"`
	}
	if err := e.parsePayload(job.Payload, &snapshot); err != nil {
		return nil, err
	}
	if snapshot.ArchiveURI != "" {
		ctx, workDir, end, err := e.beginSnapshot(ctx, job)
		if err != nil {
			return nil, err
		}
		defer end()
		info, err := e.backend.GetBoxInfo(ctx, job.ResourceId)
		if err != nil {
			return nil, err
		}
		// Reconciliation may already have released the source archive after a
		// successful first start. A replay needs neither the archive nor a boot.
		if !info.StartedAt.IsZero() {
			return dto.StartBoxResponse{}, nil
		}
		createBoxDto.SnapshotArchivePath = filepath.Join(workDir, snapshotArchiveName)
		if err := e.archiveStore.Download(ctx, snapshot.ArchiveURI, createBoxDto.SnapshotArchivePath); err != nil {
			return nil, err
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		_, daemonVersion, err := e.backend.Create(context.WithoutCancel(ctx), createBoxDto)
		if err != nil {
			return nil, err
		}
		return dto.StartBoxResponse{DaemonVersion: daemonVersion}, ctx.Err()
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
