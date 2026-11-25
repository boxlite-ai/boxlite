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
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

type recoveryNative struct {
	mu            sync.Mutex
	current       *NativeBox
	importErr     error
	commitThenErr bool
	removes       int
	imports       int
	candidates    map[string]*NativeBox
	operations    Operations
	target        string
	entered       chan struct{}
	resume        chan struct{}
	importPath    string
	downloadPath  string
	env           map[string]string
}

func (n *recoveryNative) Lookup(_ context.Context, target string) (*NativeBox, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	id, err := n.operations.Resolve(target)
	if err != nil {
		return nil, err
	}
	for name, candidate := range n.candidates {
		if id == name || id == candidate.ID {
			copy := *candidate
			return &copy, nil
		}
	}
	if n.current != nil && (id == n.target || id == n.current.ID) {
		copy := *n.current
		return &copy, nil
	}
	return nil, nil
}

func (n *recoveryNative) Remove(_ context.Context, id string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.current == nil || n.current.ID != id {
		return errors.New("wrong predecessor removed")
	}
	n.removes++
	n.current = nil
	published, err := n.operations.Resolve(n.target)
	if err != nil {
		return err
	}
	for name, candidate := range n.candidates {
		if candidate.ID == id {
			delete(n.candidates, name)
		} else if candidate.ID == published {
			n.current = candidate
		}
	}
	return nil
}

func (n *recoveryNative) Import(ctx context.Context, source *DownloadedArchive, env map[string]string, name string) (string, error) {
	path := source.Path
	n.mu.Lock()
	n.imports++
	n.importPath, n.downloadPath, n.env = path, path, env
	entered, resume := n.entered, n.resume
	n.mu.Unlock()
	if entered != nil {
		close(entered)
		select {
		case <-resume:
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	if _, err := os.ReadFile(path); err != nil {
		return "", fmt.Errorf("import lost its archive: %w", err)
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.importErr != nil && !n.commitThenErr {
		return "", n.importErr
	}
	candidate := &NativeBox{ID: uuid.NewString(), State: "stopped"}
	n.candidates[name] = candidate
	if n.current == nil {
		n.current = candidate
	}
	return candidate.ID, n.importErr
}

func recoveryHarness(t *testing.T) (Restorer, RestoreRequest, *recoveryNative, *downloadStore) {
	t.Helper()
	artifacts, artifact, store := uploaded(t)
	native := &recoveryNative{current: &NativeBox{ID: uuid.NewString(), State: "stopped"}, candidates: make(map[string]*NativeBox)}
	target := uuid.NewString()
	request := RestoreRequest{
		OperationID: uuid.NewString(), Sequence: 1, Target: target, Mode: "recover", Archive: artifact,
		PlatformEnv: map[string]string{"BOXLITE_BOX_ID": target},
	}
	operations := Operations{Root: filepath.Join(t.TempDir(), "operations")}
	native.operations, native.target = operations, target
	return Restorer{Operations: operations, Artifacts: artifacts, Store: store, Backend: native}, request, native, store
}

type managedRecoveryNative struct {
	*recoveryNative
	installed json.RawMessage
}

func (n *managedRecoveryNative) ImportManaged(ctx context.Context, archive *DownloadedArchive, env map[string]string, name string, snapshot json.RawMessage) (string, error) {
	id, err := n.Import(ctx, archive, env, name)
	if err == nil {
		n.candidates[name].ProtectedOutbound = true
		n.installed = append(json.RawMessage(nil), snapshot...)
	}
	return id, err
}

func (n *managedRecoveryNative) VerifyManaged(_ context.Context, _ string, snapshot json.RawMessage) error {
	if string(n.installed) != string(snapshot) {
		return errors.New("different persisted policy")
	}
	return nil
}

func TestCheckpointManagedRestoreVerifiesReplayAndFencesLateImports(t *testing.T) {
	const snapshot = `{"admission":"extended_ipv4","revision":"copy-revision","policy":{"mode":"enabled","allow_net":[],"deny_net":["example.test"]}}`
	for _, scenario := range []string{"verified-replay", "cleaned-before-import", "retired-before-cleanup"} {
		t.Run(scenario, func(t *testing.T) {
			ctx := t.Context()
			restore, request, native, _ := recoveryHarness(t)
			native.current = nil
			request.Mode, request.TargetOutbound = "create", json.RawMessage(snapshot)
			managed := &managedRecoveryNative{recoveryNative: native}
			restore.Backend = managed
			attempt := uuid.NewString()
			if _, err := restore.Restore(ctx, request, attempt); err == nil || native.imports != 0 {
				t.Fatal("protected restore reached native import without lease authorization")
			}
			restore.AuthorizeManaged = func(context.Context) error { return nil }
			if scenario != "verified-replay" {
				if scenario == "retired-before-cleanup" {
					lease, err := restore.Operations.Lock(ctx, request.Target)
					if err != nil {
						t.Fatal(err)
					}
					err = lease.Retire()
					lease.Close()
					if err != nil {
						t.Fatal(err)
					}
				}
				if err := restore.CleanManaged(ctx, request, attempt, restore.AuthorizeManaged); err != nil {
					t.Fatal(err)
				}
				restarted := restore
				restarted.Operations = Operations{Root: restore.Operations.Root}
				if _, err := restarted.Restore(ctx, request, attempt); err == nil || native.imports != 0 {
					t.Fatal("restarted worker imported a cleaned operation")
				}
				return
			}
			first, err := restore.Restore(ctx, request, attempt)
			if err != nil {
				t.Fatal(err)
			}
			replay, err := restore.Restore(ctx, request, attempt)
			if err != nil || replay.NativeID != first.NativeID || native.imports != 1 {
				t.Fatalf("valid replay should reuse its protected candidate: %#v, %v", replay, err)
			}
			managed.installed = json.RawMessage(`{"revision":"wrong"}`)
			if _, err := restore.Restore(ctx, request, attempt); err == nil || !strings.Contains(err.Error(), "different persisted policy") {
				t.Fatalf("changed candidate passed protected replay: %v", err)
			}
		})
	}
}

type stalledManagedDownload struct {
	*downloadStore
	entered chan struct{}
	rescue  chan struct{}
}

func (s *stalledManagedDownload) Download(ctx context.Context, _, _ string) error {
	close(s.entered)
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-s.rescue:
		return errors.New("release stalled test store")
	}
}

func TestManagedCheckpointCancellationStopsDownloadBeforeImport(t *testing.T) {
	restore, request, native, store := recoveryHarness(t)
	native.current = nil
	request.Mode, request.TargetOutbound = "create", json.RawMessage(`{"revision":"expected"}`)
	restore.Backend = &managedRecoveryNative{recoveryNative: native}
	restore.AuthorizeManaged = func(context.Context) error { return nil }
	stalled := &stalledManagedDownload{downloadStore: store, entered: make(chan struct{}), rescue: make(chan struct{})}
	defer close(stalled.rescue)
	restore.Store = stalled
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	finished := make(chan error, 1)
	go func() {
		_, err := restore.Restore(ctx, request, uuid.NewString())
		finished <- err
	}()
	select {
	case <-stalled.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the managed download did not start")
	}
	cancel()
	if err := <-finished; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled restore returned %v", err)
	}

	wait, stop := context.WithTimeout(t.Context(), time.Second)
	defer stop()
	lease, err := restore.Operations.Lock(wait, request.Target)
	if err != nil {
		t.Fatalf("stalled download still owns the target after cancellation: %v", err)
	}
	defer lease.Close()
	if native.imports != 0 {
		t.Fatal("a cancelled download reached native import")
	}
}

func TestCheckpointRestoreImportFailurePreservesPredecessor(t *testing.T) {
	r, request, native, _ := recoveryHarness(t)
	predecessor := native.current.ID
	native.importErr = errors.New("native import failed")
	if _, err := r.Restore(t.Context(), request, uuid.NewString()); err == nil {
		t.Fatal("import failure was hidden")
	}
	if native.current == nil || native.current.ID != predecessor || native.removes != 0 {
		t.Fatal("import failure removed the predecessor")
	}
}

func TestCheckpointRestoreImportFailureAllowsOriginalLifecycleAndRetry(t *testing.T) {
	r, request, native, _ := recoveryHarness(t)
	native.importErr = errors.New("native import is unavailable")
	predecessor := native.current.ID
	if _, err := r.Restore(context.Background(), request, uuid.NewString()); err == nil {
		t.Fatal("import failure allowed replacement")
	}
	if native.current.ID != predecessor || native.removes != 0 || native.imports != 1 {
		t.Fatal("import failure changed the target")
	}
	lease, err := r.Operations.Lock(context.Background(), request.Target)
	if err != nil {
		t.Fatal(err)
	}
	if err := lease.CheckIdle(); err != nil {
		t.Fatalf("non-destructive import failure blocked ordinary start: %v", err)
	}
	lease.Close()
	native.importErr = nil
	completed, err := r.Restore(context.Background(), request, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	if completed.NativeID == predecessor || completed.NativeID != native.current.ID || native.removes != 1 || native.imports != 2 {
		t.Fatalf("replacement result/counters: %#v %#v", completed, native)
	}
	if native.env["BOXLITE_BOX_ID"] != request.Target {
		t.Fatal("target identity did not reach preparation")
	}
	for _, path := range []string{native.downloadPath, native.importPath} {
		if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("completed attempt leaked temporary archive %s: %v", path, err)
		}
	}
}

func TestCheckpointRestoreRejectsSameLengthCorruptionBeforeNativePreparation(t *testing.T) {
	r, request, native, store := recoveryHarness(t)
	store.damage = "corrupt"
	predecessor := native.current.ID
	if _, err := r.Restore(t.Context(), request, uuid.NewString()); err == nil || !strings.Contains(err.Error(), "SHA-256") {
		t.Fatalf("corrupted download reached native restore: %v", err)
	}
	if native.removes != 0 || native.imports != 0 || native.current.ID != predecessor {
		t.Fatal("cloud integrity failure changed native state")
	}
}

func TestCheckpointRestoreRetainsLateNativeSuccessAfterCallerCancellation(t *testing.T) {
	r, request, native, store := recoveryHarness(t)
	native.entered, native.resume = make(chan struct{}), make(chan struct{})
	var release sync.Once
	defer release.Do(func() { close(native.resume) })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := r.Restore(ctx, request, uuid.NewString())
		done <- err
	}()
	select {
	case <-native.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("native import was not reached")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled waiter: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancelled caller remained blocked")
	}
	// Cancellation occurred before the native result. The accepted worker
	// still holds the target lease and both actual staging files.
	contender, stop := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer stop()
	if lease, err := r.Operations.Lock(contender, request.Target); err == nil {
		lease.Close()
		t.Fatal("caller cancellation released native operation ownership")
	} else if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	for _, path := range []string{native.downloadPath, native.importPath} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("native operation lost %s: %v", path, err)
		}
	}
	release.Do(func() { close(native.resume) })
	joined, stopJoin := context.WithTimeout(context.Background(), 5*time.Second)
	defer stopJoin()
	lease, err := r.Operations.Lock(joined, request.Target)
	if err != nil {
		t.Fatal(err)
	}
	record, err := lease.read()
	lease.Close()
	if err != nil || record == nil || record.Stage != "accepted" {
		t.Fatalf("late native completion was not recorded: %#v %v", record, err)
	}
	current, err := native.Lookup(context.Background(), request.Target)
	if err != nil || current == nil || current.ID != record.AcceptedID {
		t.Fatalf("accepted child did not survive cancellation: %#v %v", current, err)
	}
	// A replay after restart must not need the object store or import again,
	// even after the already accepted box has subsequently been started.
	native.mu.Lock()
	native.current.State = "running"
	native.mu.Unlock()
	store.mu.Lock()
	delete(store.uploaded, request.Archive.ArcPath)
	store.mu.Unlock()
	r.Operations = Operations{Root: r.Operations.Root}
	result, err := r.Restore(context.Background(), request, uuid.NewString())
	if err != nil || result.NativeID != current.ID || native.imports != 1 || native.removes != 1 {
		t.Fatalf("late success replay: %#v %v", result, err)
	}
}

func TestCheckpointRestoreResumesPredecessorCleanupWithoutImportingAgain(t *testing.T) {
	r, request, native, store := recoveryHarness(t)
	predecessor := native.current.ID
	r.Backend = restoreBoundaryBackend{recoveryNative: native, removeErr: errors.New("cleanup failed")}
	if _, err := r.Restore(t.Context(), request, uuid.NewString()); err == nil {
		t.Fatal("cleanup failure was hidden")
	}
	published, err := native.Lookup(t.Context(), request.Target)
	if err != nil || published == nil || published.ID == predecessor || native.current.ID != predecessor {
		t.Fatalf("candidate was not published before cleanup: %#v %v", published, err)
	}
	store.mu.Lock()
	delete(store.uploaded, request.Archive.ArcPath)
	store.mu.Unlock()
	r.Backend = native
	result, err := r.Restore(t.Context(), request, uuid.NewString())
	if err != nil || result.NativeID != published.ID || native.removes != 1 || native.imports != 1 {
		t.Fatalf("cleanup retry imported again: %#v %v", result, err)
	}
}

func TestCheckpointRestoreAdoptsNativeCommittedBeforeReceipt(t *testing.T) {
	r, request, native, store := recoveryHarness(t)
	native.importErr, native.commitThenErr = errors.New("native result was lost"), true
	if _, err := r.Restore(context.Background(), request, uuid.NewString()); err == nil {
		t.Fatal("missing native result should leave a retryable operation")
	}
	accepted := native.candidates["checkpoint-"+request.OperationID].ID
	store.mu.Lock()
	delete(store.uploaded, request.Archive.ArcPath)
	store.mu.Unlock()
	r.Operations = Operations{Root: r.Operations.Root}
	result, err := r.Restore(context.Background(), request, uuid.NewString())
	if err != nil || result.NativeID != accepted || native.removes != 1 || native.imports != 1 {
		t.Fatalf("native acceptance was not reconciled: %#v %v", result, err)
	}
}

func TestCheckpointRestoreFencesInvalidatedAndOlderOperations(t *testing.T) {
	r, request, native, _ := recoveryHarness(t)
	if _, err := r.Restore(context.Background(), request, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	lease, err := r.Operations.Lock(context.Background(), request.Target)
	if err != nil {
		t.Fatal(err)
	}
	if err := lease.Invalidate(); err != nil {
		t.Fatal(err)
	}
	lease.Close()
	if _, err := r.Restore(context.Background(), request, uuid.NewString()); err == nil {
		t.Fatal("invalidated checkpoint operation was replayed")
	}
	next := request
	next.OperationID, next.Sequence = uuid.NewString(), 2
	if _, err := r.Restore(context.Background(), next, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	accepted := native.current.ID
	if _, err := r.Restore(context.Background(), request, uuid.NewString()); err == nil {
		t.Fatal("old sequence replaced a newer checkpoint result")
	}
	if native.current.ID != accepted || native.removes != 2 || native.imports != 2 {
		t.Fatal("stale operation had a native effect")
	}
}

func TestCheckpointDeletedTargetRejectsLateDeliveryEvenBeforeItsFirstImport(t *testing.T) {
	for _, delivered := range []bool{false, true} {
		t.Run(fmt.Sprint(delivered), func(t *testing.T) {
			r, request, native, _ := recoveryHarness(t)
			request.Mode, native.current = "create", nil
			if delivered {
				if _, err := r.Restore(context.Background(), request, uuid.NewString()); err != nil {
					t.Fatal(err)
				}
			}
			lease, err := r.Operations.Lock(context.Background(), request.Target)
			if err != nil {
				t.Fatal(err)
			}
			if err := lease.Retire(); err != nil {
				t.Fatal(err)
			}
			lease.Close()
			native.current = nil
			before := native.imports
			for _, sequence := range []int64{request.Sequence, request.Sequence + 1} {
				request.Sequence = sequence
				if _, err := r.Restore(context.Background(), request, uuid.NewString()); err == nil {
					t.Fatal("deleted public Box ID accepted a late checkpoint create")
				}
			}
			if native.current != nil || native.imports != before {
				t.Fatal("late delivery recreated a deleted Box")
			}
		})
	}
}

func TestCheckpointRestoreCreateAndInputBoundaries(t *testing.T) {
	for _, scenario := range []string{"create", "existing create", "running recovery", "live stopped target", "changed archive", "wrong identity"} {
		t.Run(scenario, func(t *testing.T) {
			r, request, native, _ := recoveryHarness(t)
			switch scenario {
			case "create":
				request.Mode, native.current = "create", nil
			case "existing create":
				request.Mode = "create"
			case "running recovery":
				native.current.State = "running"
			case "live stopped target":
				native.current.PID = 1
			case "changed archive":
				request.Archive.SHA256 = "bad"
			case "wrong identity":
				request.PlatformEnv["BOXLITE_BOX_ID"] = "source"
			}
			result, err := r.Restore(context.Background(), request, uuid.NewString())
			if scenario == "create" {
				if err != nil || native.current == nil || result.NativeID != native.current.ID || native.removes != 0 || native.imports != 1 {
					t.Fatalf("checkpoint create: %#v %v", result, err)
				}
			} else if err == nil || native.removes != 0 || native.imports != 0 {
				t.Fatalf("invalid replacement had an effect: %#v %v", result, err)
			}
		})
	}
}
