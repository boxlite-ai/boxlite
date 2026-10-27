/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

package executor

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
)

// The two snapshot jobs. Each runs on the runner holding the box, against a
// box the control plane keeps in EXPORTING or IMPORTING until the job reports
// back; the control plane settles everything else. A redelivered job
// converges: an export overwrites the same object, and a restore swaps in the
// same disk again.
//
//	CREATE_SNAPSHOT   export the stopped box, upload the archive
//	RESTORE_SNAPSHOT  download the archive, swap it in as the box's disk
//
// Destroying the box cancels whichever of them is running (see destroyBox).
// The runtime cannot stop an export or a restore it has begun, and the SDK
// call would return on cancellation while that work still reads or replaces
// the disk, so each job calls the runtime with a context the cancellation does
// not reach and acts on the cancellation once the runtime has let go.
// Like the migration jobs, they report failures verbatim: a snapshot failure
// must never read as a request to recover the box.

// snapshotHeartbeatInterval is how often a running snapshot job tells the
// control plane it is alive, well inside the API's ten-minute stale-job sweep.
const snapshotHeartbeatInterval = 2 * time.Minute

// snapshotArchiveName is what a restore downloads the archive as.
const snapshotArchiveName = "snapshot" + migrateArchiveSuffix

func (e *Executor) createSnapshot(ctx context.Context, job *apiclient.Job) (any, error) {
	payload, err := e.snapshotPayload(job)
	if err != nil {
		return nil, err
	}
	ctx, workDir, end, err := e.beginSnapshot(ctx, job)
	if err != nil {
		return nil, err
	}
	defer end()

	archivePath, err := e.backend.ExportBox(context.WithoutCancel(ctx), job.ResourceId, workDir)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	archive, err := os.Stat(archivePath)
	if err != nil {
		return nil, fmt.Errorf("failed to stat exported archive %s: %w", archivePath, err)
	}
	if err := e.archiveStore.Upload(ctx, payload.ArchiveUri, archivePath); err != nil {
		return nil, err
	}

	return SnapshotArchiveResult{SizeBytes: archive.Size()}, nil
}

func (e *Executor) restoreSnapshot(ctx context.Context, job *apiclient.Job) (any, error) {
	payload, err := e.snapshotPayload(job)
	if err != nil {
		return nil, err
	}
	ctx, workDir, end, err := e.beginSnapshot(ctx, job)
	if err != nil {
		return nil, err
	}
	defer end()

	archivePath := filepath.Join(workDir, snapshotArchiveName)
	if err := e.archiveStore.Download(ctx, payload.ArchiveUri, archivePath); err != nil {
		return nil, err
	}

	// The runtime validates the archive before it touches the box, then swaps
	// the disk in one rename: a failure here leaves the original disk in place.
	if err := e.backend.RestoreBoxFromArchive(context.WithoutCancel(ctx), job.ResourceId, archivePath); err != nil {
		return nil, err
	}
	return nil, ctx.Err()
}

// snapshotPayload parses the archive URI the control plane assigned. It is
// required for the same reason a migration's arcPath is: the object the job
// acts on must be the one the control plane recorded.
func (e *Executor) snapshotPayload(job *apiclient.Job) (SnapshotArchivePayload, error) {
	var payload SnapshotArchivePayload
	if err := e.parsePayload(job.Payload, &payload); err != nil {
		return payload, fmt.Errorf("failed to unmarshal payload: %w", err)
	}
	if payload.ArchiveUri == "" {
		return payload, fmt.Errorf("archiveUri is required for %s", job.GetType())
	}
	return payload, nil
}

// beginSnapshot registers the job against its box so a destroy can cancel it,
// starts its heartbeat, and gives it a work directory of its own — emptied
// first, so a redelivered job starts from nothing. The returned function
// undoes all three.
func (e *Executor) beginSnapshot(ctx context.Context, job *apiclient.Job) (context.Context, string, func(), error) {
	if e.archiveStore == nil || e.snapshotWorkDir == "" {
		return nil, "", nil, fmt.Errorf("snapshot archive store or work directory is not configured on this runner")
	}

	ctx, endOperation, err := e.boxOps.begin(ctx, job.ResourceId)
	if err != nil {
		return nil, "", nil, err
	}

	workDir := filepath.Join(e.snapshotWorkDir, job.GetId())
	if err := os.RemoveAll(workDir); err == nil {
		err = os.MkdirAll(workDir, 0700)
	}
	if err != nil {
		endOperation()
		return nil, "", nil, fmt.Errorf("failed to prepare snapshot work directory %s: %w", workDir, err)
	}

	stopHeartbeat := e.keepJobAlive(ctx, job.GetId())
	end := func() {
		stopHeartbeat()
		if err := os.RemoveAll(workDir); err != nil {
			e.log.WarnContext(ctx, "failed to remove snapshot work directory", "path", workDir, "error", err)
		}
		endOperation()
	}
	return ctx, workDir, end, nil
}

// keepJobAlive reports the job IN_PROGRESS on every heartbeat until the
// returned function is called. A missed beat only logs: the next one, or the
// job's own completion, still reaches the control plane.
func (e *Executor) keepJobAlive(ctx context.Context, jobId string) func() {
	interval := e.heartbeatInterval
	if interval <= 0 {
		interval = snapshotHeartbeatInterval
	}

	ctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := e.updateJobStatus(ctx, jobId, apiclient.JOBSTATUS_IN_PROGRESS, nil, nil); err != nil && ctx.Err() == nil {
					e.log.WarnContext(ctx, "failed to report snapshot job progress", "job_id", jobId, "error", err)
				}
			}
		}
	}()

	return func() {
		cancel()
		<-done
	}
}
