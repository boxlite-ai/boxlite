package executor

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	runnerapiclient "github.com/boxlite-ai/runner/pkg/apiclient"
	"github.com/boxlite-ai/runner/pkg/checkpoint"
	"github.com/boxlite-ai/runner/pkg/storage"
	"github.com/google/uuid"
)

const (
	protectedExport = "EXPORT_PROTECTED_CHECKPOINT"
	protectedUpload = "UPLOAD_PROTECTED_CHECKPOINT"
	protectedImport = "IMPORT_PROTECTED_CHECKPOINT"

	protectedCheckpointAttemptTimeout = 30 * time.Minute
	protectedCheckpointCleanupTimeout = time.Minute
)

type protectedCheckpointBackend interface {
	ExportManagedCheckpoint(context.Context, string, string, json.RawMessage) (string, string, error)
	RestoreManagedCheckpoint(context.Context, checkpoint.RestoreRequest, string, checkpoint.Artifacts, storage.ArchiveStore, func(context.Context) error) (checkpoint.RestoreResult, error)
	CleanManagedCheckpoint(context.Context, checkpoint.RestoreRequest, string, checkpoint.Artifacts, func(context.Context) error) error
}

type protectedCheckpointPayload struct {
	ExportCheckpointPayload
	CaptureOutbound json.RawMessage            `json:"captureOutbound"`
	Archive         *checkpoint.Artifact       `json:"archive"`
	Restore         *checkpoint.RestoreRequest `json:"restore"`
}

type protectedCheckpointReceipt struct {
	Kind            string               `json:"kind"`
	Outcome         string               `json:"outcome"`
	Archive         *checkpoint.Artifact `json:"archive,omitempty"`
	CaptureOutbound json.RawMessage      `json:"captureOutbound,omitempty"`
	checkpoint.RestoreResult
}

func (e *Executor) ExecuteProtectedCheckpoint(ctx context.Context, lease string, job runnerapiclient.ProtectedCheckpointJob) {
	id, err := uuid.Parse(job.ID)
	if err != nil || id.String() != job.ID {
		e.log.WarnContext(ctx, "Invalid protected checkpoint job identity")
		return
	}
	var payload protectedCheckpointPayload
	if err := json.Unmarshal(job.Payload, &payload); err != nil {
		e.log.WarnContext(ctx, "Invalid protected checkpoint payload", "job_id", job.ID)
		return
	}
	authorize := func(ctx context.Context) error {
		return runnerapiclient.AuthorizeProtectedCheckpoint(ctx, e.client, lease, job.ID, job.Cleanup)
	}
	receipt, err := e.runProtectedCheckpoint(ctx, job, payload, authorize)
	if err != nil {
		e.log.WarnContext(ctx, "Protected checkpoint job did not complete", "job_id", job.ID, "error", err)
		if job.Cleanup || ctx.Err() != nil {
			return
		}
		receipt = protectedCheckpointReceipt{Kind: job.Type, Outcome: "failed"}
	}
	if err := runnerapiclient.ReportProtectedCheckpoint(ctx, e.client, lease, job.ID, receipt); err != nil {
		e.log.WarnContext(ctx, "Protected checkpoint receipt awaits reconciliation", "job_id", job.ID, "error", err)
		return
	}
}

func (e *Executor) runProtectedCheckpoint(ctx context.Context, job runnerapiclient.ProtectedCheckpointJob, payload protectedCheckpointPayload, authorize func(context.Context) error) (protectedCheckpointReceipt, error) {
	timeout := protectedCheckpointAttemptTimeout
	if job.Cleanup {
		timeout = protectedCheckpointCleanupTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	receipt := protectedCheckpointReceipt{Kind: job.Type, Outcome: "completed"}
	artifacts, err := e.checkpointSetup(payload.ArcPath)
	if err != nil {
		return receipt, err
	}
	backend, ok := e.backend.(protectedCheckpointBackend)
	if !ok || len(payload.CaptureOutbound) == 0 {
		return receipt, fmt.Errorf("protected checkpoint requires a compatible backend and capture policy")
	}
	if job.Cleanup {
		receipt.Outcome = "cleaned"
	}
	switch job.Type {
	case protectedExport:
		ref := checkpoint.Reference{CheckpointID: payload.CheckpointID, ExportJobID: job.ID, SourceBoxID: job.ResourceID, ArcPath: payload.ArcPath}
		if job.Cleanup {
			return receipt, artifacts.CleanRejected(ctx, ref, e.archiveStore, authorize)
		}
		archive, err := artifacts.ExportAuthorized(ctx, ref, func(ctx context.Context, directory string) (string, string, error) {
			return backend.ExportManagedCheckpoint(ctx, job.ResourceID, directory, payload.CaptureOutbound)
		}, authorize)
		receipt.Archive, receipt.CaptureOutbound = &archive, payload.CaptureOutbound
		return receipt, err
	case protectedUpload:
		if payload.Archive == nil || payload.Archive.CheckpointID != job.ResourceID || payload.Archive.ArcPath != payload.ArcPath {
			return receipt, fmt.Errorf("protected checkpoint upload archive does not match its job")
		}
		if job.Cleanup {
			if job.CleanupPublished {
				return receipt, artifacts.AcknowledgeAuthorized(ctx, *payload.Archive, authorize)
			}
			return receipt, artifacts.CleanRejected(ctx, payload.Archive.Reference, e.archiveStore, authorize)
		}
		archive, err := artifacts.UploadAuthorized(ctx, *payload.Archive, e.archiveStore, authorize)
		receipt.Archive, receipt.CaptureOutbound = &archive, payload.CaptureOutbound
		return receipt, err
	case protectedImport:
		if payload.Restore == nil || payload.Restore.Target != job.ResourceID || payload.Archive == nil ||
			payload.Archive.CheckpointID != payload.CheckpointID || payload.Archive.ArcPath != payload.ArcPath {
			return receipt, fmt.Errorf("protected checkpoint restore does not match its job")
		}
		restore := *payload.Restore
		restore.Archive = *payload.Archive
		if job.Cleanup {
			return receipt, backend.CleanManagedCheckpoint(ctx, restore, job.ID, artifacts, authorize)
		}
		receipt.RestoreResult, err = backend.RestoreManagedCheckpoint(ctx, restore, job.ID, artifacts, e.archiveStore, authorize)
		return receipt, err
	default:
		return receipt, fmt.Errorf("unsupported protected checkpoint job type %q", job.Type)
	}
}
