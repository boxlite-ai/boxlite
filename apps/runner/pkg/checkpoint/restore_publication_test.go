// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package checkpoint

import (
	"errors"
	"os"
	"slices"
	"testing"

	"github.com/google/uuid"
)

func TestCheckpointPublicationFailureRetainsPredecessorAndAdoptsCandidate(t *testing.T) {
	r, request, native, store := recoveryHarness(t)
	predecessor := native.current.ID
	lease, err := r.Operations.Lock(t.Context(), request.Target)
	if err != nil {
		t.Fatal(err)
	}
	path := lease.path
	lease.Close()
	var intent []byte
	r.Backend = restoreBoundaryBackend{recoveryNative: native, afterImport: func() error {
		var err error
		intent, err = os.ReadFile(path)
		if err != nil {
			return err
		}
		if err := os.Remove(path); err != nil {
			return err
		}
		return os.Mkdir(path, 0700)
	}}
	if _, err := r.Restore(t.Context(), request, uuid.NewString()); err == nil {
		t.Fatal("publication failure was hidden")
	}
	if native.current == nil || native.current.ID != predecessor || native.removes != 0 {
		t.Fatal("publication failure removed predecessor")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, intent, 0600); err != nil {
		t.Fatal(err)
	}
	store.mu.Lock()
	delete(store.uploaded, request.Archive.ArcPath)
	store.mu.Unlock()
	r.Backend = native
	completed, err := r.Restore(t.Context(), request, uuid.NewString())
	if err != nil || completed.NativeID == predecessor || native.imports != 1 || native.removes != 1 {
		t.Fatalf("publication retry: %#v %v", completed, err)
	}
}

func TestCheckpointMappingSurvivesInvalidationAndRetirement(t *testing.T) {
	r, request, _, _ := recoveryHarness(t)
	completed, err := r.Restore(t.Context(), request, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	operations := Operations{Root: r.Operations.Root}
	for _, retire := range []bool{false, true} {
		lease, err := operations.Lock(t.Context(), request.Target)
		if err != nil {
			t.Fatal(err)
		}
		if retire {
			err = lease.Retire()
		} else {
			err = lease.Invalidate()
		}
		if err != nil {
			t.Fatal(err)
		}
		ids, err := lease.NativeTargets()
		lease.Close()
		if err != nil || !slices.Contains(ids, completed.NativeID) {
			t.Fatalf("lost cleanup identity: %v %v", ids, err)
		}
		id, err := operations.Resolve(request.Target)
		if err != nil || id != completed.NativeID {
			t.Fatalf("lost published identity: %q %v", id, err)
		}
		bindings, err := operations.Bindings()
		if err != nil || bindings[request.Target] != completed.NativeID {
			t.Fatalf("lost inventory mapping: %v %v", bindings, err)
		}
	}
	lease, err := operations.Lock(t.Context(), request.Target)
	if err != nil {
		t.Fatal(err)
	}
	if err := lease.ClearPublished(); err != nil {
		t.Fatal(err)
	}
	lease.Close()
	if id, err := operations.Resolve(request.Target); err != nil || id != request.Target {
		t.Fatalf("cleared mapping: %q %v", id, err)
	}
}

func TestCheckpointCleanupMustFinishBeforeAnotherOperation(t *testing.T) {
	r, request, native, _ := recoveryHarness(t)
	r.Backend = restoreBoundaryBackend{recoveryNative: native, removeErr: errors.New("cleanup failed")}
	if _, err := r.Restore(t.Context(), request, uuid.NewString()); err == nil {
		t.Fatal("cleanup failure hidden")
	}
	lease, err := r.Operations.Lock(t.Context(), request.Target)
	if err != nil {
		t.Fatal(err)
	}
	if err := lease.CheckIdle(); err == nil {
		t.Fatal("unfinished cleanup allowed ordinary create")
	}
	lease.Close()
	request.OperationID, request.Sequence = uuid.NewString(), 2
	if _, err := r.Restore(t.Context(), request, uuid.NewString()); err == nil {
		t.Fatal("another operation discarded pending cleanup")
	}
	if native.imports != 1 {
		t.Fatal("another candidate was imported")
	}
}
