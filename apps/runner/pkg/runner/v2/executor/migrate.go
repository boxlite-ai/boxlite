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
	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/storage"
)

// The five migration jobs, in the order a migration runs them. The control
// plane owns the state machine; a runner only performs the step it was handed
// and reports the outcome, and every step is written so that a redelivery of
// the same job converges instead of failing.
//
//	EXPORT_BOX            runnerA  pack the box, upload the archive
//	IMPORT_BOX            runnerB  download the archive, restore the box
//	ROLLBACK_EXPORT_BOX   runnerA  drop the archive a rolled-back migration left
//	ROLLBACK_IMPORT_BOX   runnerB  destroy the box a rolled-back migration created
//	DISCARD_EXPORTED_BOX  runnerA  drop the archive and destroy the original box
//
// Unlike the box lifecycle handlers, these report their failures verbatim rather
// than through common.FormatRecoverableError. That marker asks the control plane
// to recover the box — destroy it and build it again — which is the one thing a
// migration must never trigger: the box it would discard is the copy the
// migration is trying to preserve. A migration failure is the control plane's to
// retry or roll back, so the runner hands it back unlabelled.

// migrateArchiveSuffix is the extension boxlite gives a portable box archive.
const migrateArchiveSuffix = ".boxlite"

func (e *Executor) migrationAuthorization(ctx context.Context, job *apiclient.Job) func() error {
	return func() error {
		probe, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		current, response, err := e.client.JobsAPI.GetJob(probe, job.Id).Execute()
		if err != nil {
			return fmt.Errorf("verify current migration job: %w", err)
		}
		if current == nil || response == nil || current.Id != job.Id ||
			current.Status != apiclient.JOBSTATUS_IN_PROGRESS ||
			response.Header.Get("X-BoxLite-Migration-Authority") != job.Id {
			return fmt.Errorf("job %s no longer owns its migration", job.Id)
		}
		return nil
	}
}

func (e *Executor) withMigrationArchive(ctx context.Context, job *apiclient.Job, effect func() error) error {
	return e.backend.WithOrdinaryTarget(ctx, job.ResourceId, func() error {
		if err := e.migrationAuthorization(ctx, job)(); err != nil {
			return err
		}
		return effect()
	})
}

func (e *Executor) exportBox(ctx context.Context, job *apiclient.Job) (any, error) {
	payload, err := e.migrateArchivePayload(job)
	if err != nil {
		return nil, err
	}
	store, err := e.requireMigrationSetup(payload.ArcPath)
	if err != nil {
		return nil, err
	}

	archiveDir, cleanup, err := e.migrationWorkspace(ctx)
	if err != nil {
		return nil, err
	}
	defer cleanup()
	archivePath, err := e.backend.ExportBox(ctx, job.ResourceId, archiveDir, e.migrationAuthorization(ctx, job))
	if err != nil {
		return nil, err
	}

	if err := e.withMigrationArchive(ctx, job, func() error {
		return store.Upload(ctx, payload.ArcPath, archivePath)
	}); err != nil {
		return nil, err
	}

	// The control plane records the key it gets back — on its rollback branch
	// too, because the object exists either way and reclaiming it needs the key.
	return MigrateArchiveResult{ArcPath: payload.ArcPath}, nil
}

func (e *Executor) importBox(ctx context.Context, job *apiclient.Job) (any, error) {
	payload, err := e.migrateArchivePayload(job)
	if err != nil {
		return nil, err
	}
	store, err := e.requireMigrationSetup(payload.ArcPath)
	if err != nil {
		return nil, err
	}

	archiveDir, cleanup, err := e.migrationWorkspace(ctx)
	if err != nil {
		return nil, err
	}
	defer cleanup()
	archivePath := filepath.Join(archiveDir, "box"+migrateArchiveSuffix)
	if err := e.withMigrationArchive(ctx, job, func() error {
		return store.Download(ctx, payload.ArcPath, archivePath)
	}); err != nil {
		return nil, err
	}

	if err := e.backend.ImportMigrationBox(ctx, job.ResourceId, archivePath, payload.AttemptID, e.migrationAuthorization(ctx, job)); err != nil {
		return nil, err
	}

	// No result metadata: the target runner is the one the control plane
	// submitted this job to, so it already holds it as job.runnerId.
	return nil, nil
}

func (e *Executor) rollbackExportBox(ctx context.Context, job *apiclient.Job) (any, error) {
	payload, err := e.migrateArchivePayload(job)
	if err != nil {
		return nil, err
	}
	store, err := e.requireMigrationSetup(payload.ArcPath)
	if err != nil {
		return nil, err
	}

	return nil, e.withMigrationArchive(ctx, job, func() error {
		return store.Remove(ctx, payload.ArcPath)
	})
}

func (e *Executor) destroyIfPresent(ctx context.Context, boxId string) error {
	err := e.backend.Destroy(ctx, boxId)
	if boxlite.IsNotFound(err) {
		return nil
	}
	return err
}

func (e *Executor) rollbackImportBox(ctx context.Context, job *apiclient.Job) (any, error) {
	var payload MigrateArchivePayload
	if job.Payload != nil {
		if err := e.parsePayload(job.Payload, &payload); err != nil {
			return nil, err
		}
	}
	return nil, e.destroyMigrationCopy(ctx, job, payload.AttemptID)
}

func (e *Executor) destroyMigrationCopy(ctx context.Context, job *apiclient.Job, importedAttemptID string) error {
	err := e.backend.DestroyMigrationCopy(ctx, job.ResourceId, importedAttemptID, e.migrationAuthorization(ctx, job))
	if boxlite.IsNotFound(err) {
		return nil
	}
	return err
}

// discardExportedBox commits the migration on the runner that gave the box up:
// the archive is no longer needed and the original box is now a duplicate of
// one running elsewhere. The archive goes first — the box is the artifact the
// control plane cannot reconstruct, so it is the last thing dropped.
func (e *Executor) discardExportedBox(ctx context.Context, job *apiclient.Job) (any, error) {
	payload, err := e.migrateArchivePayload(job)
	if err != nil {
		return nil, err
	}
	store, err := e.requireMigrationSetup(payload.ArcPath)
	if err != nil {
		return nil, err
	}

	if err := e.withMigrationArchive(ctx, job, func() error {
		return store.Remove(ctx, payload.ArcPath)
	}); err != nil {
		return nil, err
	}

	return nil, e.destroyMigrationCopy(ctx, job, "")
}

// migrateArchivePayload parses the archive key the control plane assigned to
// this migration. It is required: a runner that picked its own key could upload
// to one object and have the control plane record another.
func (e *Executor) migrateArchivePayload(job *apiclient.Job) (MigrateArchivePayload, error) {
	var payload MigrateArchivePayload
	if err := e.parsePayload(job.Payload, &payload); err != nil {
		return payload, fmt.Errorf("failed to unmarshal payload: %w", err)
	}
	if payload.ArcPath == "" {
		return payload, fmt.Errorf("arcPath is required for %s", job.GetType())
	}
	return payload, nil
}

// requireMigrationSetup returns the object store to move the archive through,
// or the reason this runner cannot serve a migration job at all.
func (e *Executor) requireMigrationSetup(arcPath string) (storage.ArchiveStore, error) {
	if e.archiveStore == nil {
		return nil, fmt.Errorf("migration archive store is not configured: set AWS_DEFAULT_BUCKET and the AWS credentials on this runner")
	}
	if e.migrateWorkDir == "" {
		return nil, fmt.Errorf("migration work directory is not configured")
	}
	if store, ok := e.archiveStore.(*storage.SchemeArchiveStore); ok {
		if err := store.Check(arcPath); err != nil {
			return nil, err
		}
	}
	return e.archiveStore, nil
}

func (e *Executor) migrationWorkspace(ctx context.Context) (string, func(), error) {
	if err := os.MkdirAll(e.migrateWorkDir, 0700); err != nil {
		return "", nil, fmt.Errorf("create migration workspace: %w", err)
	}
	dir, err := os.MkdirTemp(e.migrateWorkDir, "migration-")
	if err != nil {
		return "", nil, fmt.Errorf("create private migration workspace: %w", err)
	}
	return dir, func() {
		if err := os.RemoveAll(dir); err != nil {
			e.log.WarnContext(ctx, "failed to remove private migration workspace", "path", dir, "error", err)
		}
	}, nil
}
