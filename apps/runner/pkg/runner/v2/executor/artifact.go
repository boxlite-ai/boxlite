/*
 * Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

package executor

import (
	"context"
	"errors"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
)

func (e *Executor) buildArtifact(ctx context.Context, job *apiclient.Job) (any, error) {
	var request dto.BuildArtifactRequestDTO
	err := e.parsePayload(job.Payload, &request)
	if err != nil {
		return nil, err
	}

	err = e.backend.BuildArtifact(ctx, request)
	if err != nil {
		return nil, err
	}

	info, err := e.backend.GetImageInfo(ctx, request.ArtifactRef)
	if err != nil {
		return nil, err
	}

	infoResponse := dto.ArtifactInfoResponse{
		Name:       request.ArtifactRef,
		SizeGB:     float64(info.Size) / (1024 * 1024 * 1024), // Convert bytes to GB
		Entrypoint: info.Entrypoint,
		Cmd:        info.Cmd,
		Hash:       dto.HashWithoutPrefix(info.Hash),
	}

	return infoResponse, nil
}

func (e *Executor) pullArtifact(ctx context.Context, job *apiclient.Job) (any, error) {
	var request dto.PullArtifactRequestDTO
	err := e.parsePayload(job.Payload, &request)
	if err != nil {
		return nil, err
	}

	err = e.backend.PullArtifact(ctx, request)
	if err != nil {
		return nil, err
	}

	artifactRef := pulledArtifactRef(request)
	info, err := e.backend.GetImageInfo(ctx, artifactRef)
	if err != nil {
		return nil, err
	}

	infoResponse := dto.ArtifactInfoResponse{
		Name:       artifactRef,
		SizeGB:     float64(info.Size) / (1024 * 1024 * 1024), // Convert bytes to GB
		Entrypoint: info.Entrypoint,
		Cmd:        info.Cmd,
		Hash:       dto.HashWithoutPrefix(info.Hash),
	}

	return infoResponse, nil
}

func pulledArtifactRef(request dto.PullArtifactRequestDTO) string {
	if request.DestinationRef != nil && *request.DestinationRef != "" {
		return *request.DestinationRef
	}

	return request.ArtifactRef
}

func (e *Executor) removeArtifact(ctx context.Context, job *apiclient.Job) (any, error) {
	if job.Payload == nil || *job.Payload == "" {
		return nil, errors.New("payload is required")
	}

	return nil, e.backend.RemoveImage(ctx, *job.Payload, true)
}

func (e *Executor) inspectArtifactInRegistry(ctx context.Context, job *apiclient.Job) (any, error) {
	var request dto.InspectArtifactInRegistryRequestDTO
	err := e.parsePayload(job.Payload, &request)
	if err != nil {
		return nil, err
	}

	digest, err := e.backend.InspectImageInRegistry(ctx, request.ArtifactRef, request.Registry)
	if err != nil {
		return nil, err
	}

	return dto.ArtifactDigestResponse{
		Hash:   dto.HashWithoutPrefix(digest.Digest),
		SizeGB: float64(digest.Size) / (1024 * 1024 * 1024),
	}, nil
}
