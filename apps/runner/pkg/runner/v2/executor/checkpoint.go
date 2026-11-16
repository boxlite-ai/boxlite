// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package executor

import (
	"context"
	"fmt"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/runner/pkg/backend"
	"github.com/boxlite-ai/runner/pkg/checkpoint"
	"github.com/boxlite-ai/runner/pkg/storage"
)

type ExportCheckpointPayload struct {
	CheckpointID string `json:"checkpointId"`
	ArcPath      string `json:"arcPath"`
}

func (e *Executor) checkpointSetup(arcPath string) (checkpoint.Artifacts, error) {
	if e.checkpointWorkDir == "" || e.archiveStore == nil {
		return checkpoint.Artifacts{}, fmt.Errorf("checkpoint work directory and archive store must be configured")
	}
	if store, ok := e.archiveStore.(*storage.SchemeArchiveStore); ok {
		if err := store.Check(arcPath); err != nil {
			return checkpoint.Artifacts{}, err
		}
	}
	return checkpoint.Artifacts{Root: e.checkpointWorkDir}, nil
}

func (e *Executor) exportCheckpoint(ctx context.Context, job *apiclient.Job) (any, error) {
	if job.ResourceType != "BOX" {
		return nil, fmt.Errorf("checkpoint export must own the source BOX job slot")
	}
	var payload ExportCheckpointPayload
	if err := e.parsePayload(job.Payload, &payload); err != nil {
		return nil, err
	}
	artifacts, err := e.checkpointSetup(payload.ArcPath)
	if err != nil {
		return nil, err
	}
	exporter, ok := e.backend.(backend.CheckpointExporter)
	if !ok {
		return nil, fmt.Errorf("backend does not support checkpoint export")
	}
	ref := checkpoint.Reference{CheckpointID: payload.CheckpointID, ExportJobID: job.Id, SourceBoxID: job.ResourceId, ArcPath: payload.ArcPath}
	return artifacts.Export(ctx, ref, func(ctx context.Context, directory string) (string, string, error) {
		return exporter.ExportCheckpoint(ctx, job.ResourceId, directory)
	})
}

func (e *Executor) uploadCheckpoint(ctx context.Context, job *apiclient.Job) (any, error) {
	var payload checkpoint.Artifact
	if err := e.parsePayload(job.Payload, &payload); err != nil {
		return nil, err
	}
	if job.ResourceType != "CHECKPOINT" || job.ResourceId != payload.CheckpointID {
		return nil, fmt.Errorf("checkpoint upload does not own its CHECKPOINT job slot")
	}
	artifacts, err := e.checkpointSetup(payload.ArcPath)
	if err != nil {
		return nil, err
	}
	return artifacts.Upload(ctx, payload, e.archiveStore)
}

func (e *Executor) acknowledgeCheckpointUpload(ctx context.Context, job *apiclient.Job) {
	if job.Type != apiclient.JOBTYPE_UPLOAD_CHECKPOINT {
		return
	}
	var payload checkpoint.Artifact
	if err := e.parsePayload(job.Payload, &payload); err != nil {
		return
	}
	if job.ResourceType != "CHECKPOINT" || job.ResourceId != payload.CheckpointID {
		return
	}
	artifacts, err := e.checkpointSetup(payload.ArcPath)
	if err != nil {
		return
	}
	if err := artifacts.Acknowledge(ctx, payload); err != nil {
		e.log.WarnContext(ctx, "failed to clean acknowledged checkpoint upload", "checkpoint_id", payload.CheckpointID, "export_job_id", payload.ExportJobID, "error", err)
	}
}

func (e *Executor) importCheckpoint(ctx context.Context, job *apiclient.Job) (any, error) {
	var request checkpoint.RestoreRequest
	if err := e.parsePayload(job.Payload, &request); err != nil {
		return nil, err
	}
	if job.ResourceType != "BOX" || request.Target != job.ResourceId {
		return nil, fmt.Errorf("checkpoint import must own the target BOX job slot")
	}
	artifacts, err := e.checkpointSetup(request.Archive.ArcPath)
	if err != nil {
		return nil, err
	}
	restorer, ok := e.backend.(backend.CheckpointRestorer)
	if !ok {
		return nil, fmt.Errorf("backend does not support checkpoint restore")
	}
	return restorer.RestoreCheckpoint(ctx, request, job.Id, artifacts, e.archiveStore)
}
