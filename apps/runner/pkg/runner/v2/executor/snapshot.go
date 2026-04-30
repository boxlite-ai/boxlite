/*
 * Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

package executor

import (
	"context"
	"errors"

	apiclient "github.com/boxlite-labs/boxlite/libs/api-client-go"
	"github.com/boxlite-labs/runner/pkg/api/dto"
)

func (e *Executor) buildSnapshot(ctx context.Context, job *apiclient.Job) (any, error) {
	var request dto.BuildSnapshotRequestDTO
	err := e.parsePayload(job.Payload, &request)
	if err != nil {
		return nil, err
	}

	err = e.backend.BuildSnapshot(ctx, request)
	if err != nil {
		return nil, err
	}

	info, err := e.backend.GetImageInfo(ctx, request.Snapshot)
	if err != nil {
		return nil, err
	}

	infoResponse := dto.SnapshotInfoResponse{
		Name:       request.Snapshot,
		SizeGB:     float64(info.Size) / (1024 * 1024 * 1024), // Convert bytes to GB
		Entrypoint: info.Entrypoint,
		Cmd:        info.Cmd,
		Hash:       dto.HashWithoutPrefix(info.Hash),
	}

	return infoResponse, nil
}

func (e *Executor) pullSnapshot(ctx context.Context, job *apiclient.Job) (any, error) {
	var request dto.PullSnapshotRequestDTO
	err := e.parsePayload(job.Payload, &request)
	if err != nil {
		return nil, err
	}

	err = e.backend.PullSnapshot(ctx, request)
	if err != nil {
		return nil, err
	}

	snapshotRef := pulledSnapshotRef(request)
	info, err := e.backend.GetImageInfo(ctx, snapshotRef)
	if err != nil {
		return nil, err
	}

	infoResponse := dto.SnapshotInfoResponse{
		Name:       snapshotRef,
		SizeGB:     float64(info.Size) / (1024 * 1024 * 1024), // Convert bytes to GB
		Entrypoint: info.Entrypoint,
		Cmd:        info.Cmd,
		Hash:       dto.HashWithoutPrefix(info.Hash),
	}

	return infoResponse, nil
}

func pulledSnapshotRef(request dto.PullSnapshotRequestDTO) string {
	if request.DestinationRef != nil && *request.DestinationRef != "" {
		return *request.DestinationRef
	}

	return request.Snapshot
}

func (e *Executor) removeSnapshot(ctx context.Context, job *apiclient.Job) (any, error) {
	if job.Payload == nil || *job.Payload == "" {
		return nil, errors.New("payload is required")
	}

	return nil, e.backend.RemoveImage(ctx, *job.Payload, true)
}

func (e *Executor) inspectSnapshotInRegistry(ctx context.Context, job *apiclient.Job) (any, error) {
	var request dto.InspectSnapshotInRegistryRequestDTO
	err := e.parsePayload(job.Payload, &request)
	if err != nil {
		return nil, err
	}

	digest, err := e.backend.InspectImageInRegistry(ctx, request.Snapshot, request.Registry)
	if err != nil {
		return nil, err
	}

	return dto.SnapshotDigestResponse{
		Hash:   dto.HashWithoutPrefix(digest.Digest),
		SizeGB: float64(digest.Size) / (1024 * 1024 * 1024),
	}, nil
}
