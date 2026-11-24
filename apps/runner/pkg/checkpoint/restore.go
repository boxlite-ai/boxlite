// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package checkpoint

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"

	"github.com/boxlite-ai/runner/pkg/storage"
	"github.com/google/uuid"
)

// RestoreRequest is immutable across job attempts. The control plane gives a
// new logical operation a higher target sequence, not merely a new job ID.
type RestoreRequest struct {
	OperationID    string            `json:"operationId"`
	Sequence       int64             `json:"targetSequence"`
	Target         string            `json:"targetBoxId"`
	Mode           string            `json:"mode"`
	Archive        Artifact          `json:"archive"`
	PlatformEnv    map[string]string `json:"platformEnv"`
	TargetOutbound json.RawMessage   `json:"targetOutbound,omitempty"`
}

func (r RestoreRequest) validate() error {
	id, err := uuid.Parse(r.OperationID)
	if err != nil || id.String() != r.OperationID || r.Sequence <= 0 || r.Sequence > 1<<53-1 || r.Target == "" {
		return fmt.Errorf("invalid checkpoint operation identity")
	}
	if r.Mode != "create" && r.Mode != "recover" {
		return fmt.Errorf("checkpoint operation must create or recover a target")
	}
	if len(r.TargetOutbound) != 0 && (r.Mode != "create" || r.TargetOutbound[0] != '{') {
		return fmt.Errorf("managed outbound checkpoints require an owned create snapshot")
	}
	if err := validateReference(r.Archive.Reference); err != nil {
		return err
	}
	if r.Archive.SizeBytes <= 0 || !sha256Digest(r.Archive.SHA256) || !pinnedImage(r.Archive.PinnedImage) {
		return fmt.Errorf("invalid checkpoint operation archive")
	}
	if r.PlatformEnv["BOXLITE_BOX_ID"] != r.Target {
		return fmt.Errorf("checkpoint platform identity does not match its target")
	}
	return nil
}

type NativeBox struct {
	ID                string
	State             string
	PID               int
	ProtectedOutbound bool
}

type RecoveryBackend interface {
	Lookup(context.Context, string) (*NativeBox, error)
	Remove(context.Context, string) error
	Import(context.Context, *DownloadedArchive, map[string]string, string) (string, error)
}

type ManagedRecoveryBackend interface {
	ImportManaged(context.Context, *DownloadedArchive, map[string]string, string, json.RawMessage) (string, error)
	VerifyManaged(context.Context, string, json.RawMessage) error
}

type RestoreResult struct {
	OperationID    string          `json:"operationId"`
	Sequence       int64           `json:"targetSequence"`
	NativeID       string          `json:"nativeId"`
	TargetOutbound json.RawMessage `json:"targetOutbound,omitempty"`
}

// Restorer imports a candidate before publishing it and removing its predecessor.
// Lifecycle calls sharing Operations cannot run inside the replacement window.
type Restorer struct {
	Operations       Operations
	Artifacts        Artifacts
	Store            storage.ArchiveStore
	Backend          RecoveryBackend
	AuthorizeManaged func(context.Context) error
}

func (r Restorer) Restore(ctx context.Context, request RestoreRequest, attemptID string) (RestoreResult, error) {
	if err := request.validate(); err != nil {
		return RestoreResult{}, err
	}
	id, err := uuid.Parse(attemptID)
	if err != nil || id.String() != attemptID || r.Backend == nil {
		return RestoreResult{}, fmt.Errorf("checkpoint restore requires a valid attempt and backend")
	}
	// Freeze maps before handing accepted work to another goroutine.
	data, err := json.Marshal(request)
	if err != nil {
		return RestoreResult{}, err
	}
	if len(data) > 60*1024 {
		return RestoreResult{}, fmt.Errorf("checkpoint restore request is too large")
	}
	var ownedRequest RestoreRequest
	if err := json.Unmarshal(data, &ownedRequest); err != nil {
		return RestoreResult{}, err
	}
	request = ownedRequest
	lease, err := r.Operations.Lock(ctx, request.Target)
	if err != nil {
		return RestoreResult{}, err
	}
	if err := lease.CheckNoCompleteCreate(); err != nil {
		lease.Close()
		return RestoreResult{}, err
	}
	if err := ctx.Err(); err != nil {
		lease.Close()
		return RestoreResult{}, err
	}
	if len(request.TargetOutbound) != 0 {
		if _, ok := r.Backend.(ManagedRecoveryBackend); !ok || r.AuthorizeManaged == nil {
			lease.Close()
			return RestoreResult{}, fmt.Errorf("managed checkpoint requires an authorized backend")
		}
		if err := r.AuthorizeManaged(ctx); err != nil {
			lease.Close()
			return RestoreResult{}, err
		}
	}
	type outcome struct {
		result RestoreResult
		err    error
	}
	done := make(chan outcome, 1)
	nativeCtx := context.WithoutCancel(ctx)
	downloadCtx := nativeCtx
	if len(request.TargetOutbound) != 0 {
		downloadCtx = ctx
	}
	go func() {
		defer lease.Close()
		result, err := r.restore(nativeCtx, downloadCtx, lease, request, attemptID)
		done <- outcome{result, err}
	}()
	select {
	case completed := <-done:
		return completed.result, completed.err
	case <-ctx.Done():
		// The worker owns the target and download until native
		// work and its journal update complete. No orphan cleanup removes it.
		return RestoreResult{}, ctx.Err()
	}
}

// CleanManaged tombstones the operation and removes its outputs under the target lock.
func (r Restorer) CleanManaged(ctx context.Context, request RestoreRequest, attemptID string, authorize func(context.Context) error) error {
	if err := request.validate(); err != nil {
		return err
	}
	id, err := uuid.Parse(attemptID)
	if err != nil || id.String() != attemptID || len(request.TargetOutbound) == 0 || authorize == nil || r.Backend == nil {
		return fmt.Errorf("invalid managed checkpoint cleanup identity")
	}
	lease, err := r.Operations.Lock(ctx, request.Target)
	if err != nil {
		return err
	}
	defer lease.Close()
	if err := authorize(ctx); err != nil {
		return err
	}
	record, err := lease.read()
	if err != nil {
		return err
	}
	if record == nil {
		record = &restoreRecord{Version: 1, Request: request}
	} else if record.Retired && record.Request.OperationID == "" {
		record.Request = request
	} else if !reflect.DeepEqual(record.Request, request) || record.PredecessorID != "" {
		return fmt.Errorf("managed cleanup does not own the checkpoint target")
	}
	record.Stage, record.Retired = "invalidated", true
	if err := lease.write(*record); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	// Native removal can outlive its waiter. Hold the target lock until it finishes.
	nativeCtx := context.WithoutCancel(ctx)
	candidate, err := r.Backend.Lookup(nativeCtx, "checkpoint-"+request.OperationID)
	if err != nil {
		return err
	}
	if candidate != nil {
		if candidate.PID != 0 || candidate.State != "stopped" || (record.AcceptedID != "" && record.AcceptedID != candidate.ID) {
			return fmt.Errorf("managed cleanup found a changed or running candidate")
		}
		if err := r.Backend.Remove(nativeCtx, candidate.ID); err != nil {
			return err
		}
	}
	work := filepath.Join(r.Artifacts.Root, request.Archive.CheckpointID)
	downloads, err := filepath.Glob(filepath.Join(work, ".download-"+attemptID+"-*"))
	if err != nil {
		return err
	}
	for _, directory := range downloads {
		if err := os.RemoveAll(directory); err != nil {
			return err
		}
	}
	record.PublishedID = ""
	return lease.write(*record)
}

func (r Restorer) restore(ctx, downloadCtx context.Context, lease *TargetLease, request RestoreRequest, attemptID string) (_ RestoreResult, err error) {
	record, err := lease.read()
	if err != nil {
		return RestoreResult{}, err
	}
	if record != nil {
		if record.Retired {
			return RestoreResult{}, fmt.Errorf("checkpoint target was deleted")
		}
		previous := record.Request
		if request.Sequence < previous.Sequence || (request.Sequence == previous.Sequence && request.OperationID != previous.OperationID) {
			return RestoreResult{}, fmt.Errorf("stale checkpoint operation")
		}
		if request.OperationID == previous.OperationID {
			if !reflect.DeepEqual(request, previous) || record.Stage == "invalidated" {
				return RestoreResult{}, fmt.Errorf("checkpoint operation changed or was invalidated")
			}
		} else {
			if record.Stage != "accepted" && record.Stage != "invalidated" && record.Stage != "preparing" {
				return RestoreResult{}, fmt.Errorf("previous checkpoint operation has unfinished work")
			}
			record = &restoreRecord{Version: 1, Request: request, Stage: "preparing", PublishedID: record.PublishedID}
		}
	}
	current, err := r.Backend.Lookup(ctx, request.Target)
	if err != nil {
		return RestoreResult{}, err
	}
	if current != nil && current.ProtectedOutbound &&
		(len(request.TargetOutbound) == 0 || record == nil || record.AcceptedID != current.ID ||
			(record.Stage != "accepted" && record.Stage != "removing")) {
		return RestoreResult{}, ErrCompleteCreateConflict
	}
	if record == nil || record.Stage == "preparing" && record.PredecessorID == "" {
		if request.Mode == "create" && current != nil {
			return RestoreResult{}, fmt.Errorf("checkpoint create target already exists")
		}
		if request.Mode == "recover" && current == nil {
			return RestoreResult{}, fmt.Errorf("checkpoint recovery target does not exist")
		}
		if record == nil {
			record = &restoreRecord{Version: 1, Request: request, Stage: "preparing"}
		}
		if current != nil {
			record.PredecessorID = current.ID
		}
	} else if record.Stage == "accepted" {
		if current == nil || current.ID != record.AcceptedID {
			return RestoreResult{}, fmt.Errorf("accepted checkpoint target was replaced or removed")
		}
		if err := r.verifyCandidatePolicy(ctx, request, current); err != nil {
			return RestoreResult{}, err
		}
		return result(*record), nil
	} else if record.Stage == "removing" {
		return r.finish(ctx, lease, record)
	}
	if current != nil {
		if current.ID != record.PredecessorID {
			return RestoreResult{}, fmt.Errorf("another native box owns the checkpoint target")
		}
		if current.PID != 0 || (current.State != "stopped" && current.State != "failed") {
			return RestoreResult{}, fmt.Errorf("checkpoint recovery requires a stopped or failed target")
		}
	}
	if err := lease.write(*record); err != nil {
		return RestoreResult{}, err
	}
	// The deterministic candidate name reconciles a native commit whose receipt
	// was lost. The public target still points at its predecessor at this stage.
	candidateName := "checkpoint-" + request.OperationID
	candidate, err := r.Backend.Lookup(ctx, candidateName)
	if err != nil {
		return RestoreResult{}, err
	}
	if candidate == nil {
		download, downloadErr := r.Artifacts.Download(downloadCtx, request.Archive, attemptID, r.Store)
		if downloadErr != nil {
			return RestoreResult{}, downloadErr
		}
		defer func() { err = errors.Join(err, download.Close()) }()
		if err := downloadCtx.Err(); err != nil {
			return RestoreResult{}, err
		}
		if len(request.TargetOutbound) != 0 {
			if err := r.AuthorizeManaged(downloadCtx); err != nil {
				return RestoreResult{}, err
			}
		}
		record.Stage = "importing"
		if err := lease.write(*record); err != nil {
			return RestoreResult{}, err
		}
		var nativeID string
		var importErr error
		if len(request.TargetOutbound) != 0 {
			nativeID, importErr = r.Backend.(ManagedRecoveryBackend).ImportManaged(ctx, download, request.PlatformEnv, candidateName, request.TargetOutbound)
		} else {
			nativeID, importErr = r.Backend.Import(ctx, download, request.PlatformEnv, candidateName)
		}
		if importErr != nil {
			return RestoreResult{}, fmt.Errorf("checkpoint import failed; original box retained: %w", importErr)
		}
		candidate = &NativeBox{ID: nativeID, State: "stopped"}
	}
	if candidate.ID == "" || candidate.ID == record.PredecessorID || candidate.PID != 0 || candidate.State != "stopped" {
		return RestoreResult{}, fmt.Errorf("checkpoint import returned an invalid native identity")
	}
	if err := r.verifyCandidatePolicy(ctx, request, candidate); err != nil {
		return RestoreResult{}, err
	}
	// Publish only a completed import. If synchronization fails after rename,
	// retries read the actual record; no error path here removes the predecessor.
	record.AcceptedID, record.PublishedID, record.Stage = candidate.ID, candidate.ID, "removing"
	if err := lease.write(*record); err != nil {
		return RestoreResult{}, fmt.Errorf("checkpoint imported as %s but completion recording failed: %w", candidate.ID, err)
	}
	return r.finish(ctx, lease, record)
}

func (r Restorer) verifyCandidatePolicy(ctx context.Context, request RestoreRequest, candidate *NativeBox) error {
	if len(request.TargetOutbound) == 0 {
		if candidate.ProtectedOutbound {
			return ErrCompleteCreateConflict
		}
		return nil
	}
	if candidate.State != "stopped" || candidate.PID != 0 {
		return fmt.Errorf("managed checkpoint candidate must remain stopped")
	}
	return r.Backend.(ManagedRecoveryBackend).VerifyManaged(ctx, candidate.ID, request.TargetOutbound)
}

func (r Restorer) finish(ctx context.Context, lease *TargetLease, record *restoreRecord) (RestoreResult, error) {
	current, err := r.Backend.Lookup(ctx, record.Request.Target)
	if err != nil || current == nil || current.ID != record.AcceptedID {
		return RestoreResult{}, fmt.Errorf("published checkpoint target is unavailable: %w", err)
	}
	if err := r.verifyCandidatePolicy(ctx, record.Request, current); err != nil {
		return RestoreResult{}, err
	}
	if record.PredecessorID != "" {
		previous, err := r.Backend.Lookup(ctx, record.PredecessorID)
		if err != nil {
			return RestoreResult{}, err
		}
		if previous != nil {
			if err := r.Backend.Remove(ctx, record.PredecessorID); err != nil {
				return RestoreResult{}, fmt.Errorf("checkpoint predecessor cleanup failed: %w", err)
			}
		}
	}
	record.Stage = "accepted"
	if err := lease.write(*record); err != nil {
		return RestoreResult{}, fmt.Errorf("checkpoint completion recording failed: %w", err)
	}
	return result(*record), nil
}

func result(record restoreRecord) RestoreResult {
	return RestoreResult{OperationID: record.Request.OperationID, Sequence: record.Request.Sequence, NativeID: record.AcceptedID, TargetOutbound: record.Request.TargetOutbound}
}
