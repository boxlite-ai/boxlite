// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package checkpoint

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

type recoveryNative struct {
	mu            sync.Mutex
	current       *NativeBox
	preflightErr  error
	importErr     error
	commitThenErr bool
	removes       int
	imports       int
	prepares      int
	entered       chan struct{}
	resume        chan struct{}
	importPath    string
	downloadPath  string
	env           map[string]string
}

func (n *recoveryNative) Lookup(context.Context, string) (*NativeBox, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.current == nil {
		return nil, nil
	}
	copy := *n.current
	return &copy, nil
}

type preparedRecovery struct{ path string }

func (p preparedRecovery) Path() string { return p.path }
func (p preparedRecovery) Close() error { return os.RemoveAll(filepath.Dir(p.path)) }

func (n *recoveryNative) Prepare(_ context.Context, source *DownloadedArchive, env map[string]string) (PreparedArchive, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.prepares++
	n.downloadPath, n.env = source.Path, env
	if n.preflightErr != nil {
		return nil, n.preflightErr
	}
	size, digest, err := checksum(source.Path)
	if err != nil || size != source.Artifact.SizeBytes || digest != source.Artifact.SHA256 {
		return nil, fmt.Errorf("preflight rejected transferred bytes: %v", err)
	}
	directory, err := os.MkdirTemp(filepath.Dir(source.Path), "derived-")
	if err != nil {
		return nil, err
	}
	path := filepath.Join(directory, "derived.boxlite")
	data, err := os.ReadFile(source.Path)
	if err == nil {
		err = os.WriteFile(path, data, 0600)
	}
	if err != nil {
		os.RemoveAll(directory)
		return nil, err
	}
	return preparedRecovery{path}, nil
}

func (n *recoveryNative) Remove(_ context.Context, id string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.current == nil || n.current.ID != id {
		return errors.New("wrong predecessor removed")
	}
	n.removes++
	n.current = nil
	return nil
}

func (n *recoveryNative) Import(ctx context.Context, path, _ string) (string, error) {
	n.mu.Lock()
	n.imports++
	n.importPath = path
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
		return "", fmt.Errorf("import lost its prepared archive: %w", err)
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.importErr != nil && !n.commitThenErr {
		return "", n.importErr
	}
	id := uuid.NewString()
	n.current = &NativeBox{ID: id, State: "stopped"}
	return id, n.importErr
}

func recoveryHarness(t *testing.T) (Restorer, RestoreRequest, *recoveryNative, *downloadStore) {
	t.Helper()
	artifacts, artifact, store := uploaded(t)
	native := &recoveryNative{current: &NativeBox{ID: uuid.NewString(), State: "stopped"}}
	target := uuid.NewString()
	request := RestoreRequest{
		OperationID: uuid.NewString(), Sequence: 1, Target: target, Mode: "recover", Archive: artifact,
		PlatformEnv: map[string]string{"BOXLITE_BOX_ID": target},
	}
	return Restorer{Operations: Operations{Root: filepath.Join(t.TempDir(), "operations")}, Artifacts: artifacts, Store: store, Backend: native}, request, native, store
}

func TestCheckpointRestorePreflightsBeforeTargetRemoval(t *testing.T) {
	r, request, native, _ := recoveryHarness(t)
	native.preflightErr = errors.New("pinned image is unavailable")
	predecessor := native.current.ID
	if _, err := r.Restore(context.Background(), request, uuid.NewString()); err == nil {
		t.Fatal("preflight failure allowed replacement")
	}
	if native.current.ID != predecessor || native.removes != 0 || native.imports != 0 {
		t.Fatal("preflight failure changed the target")
	}
	lease, err := r.Operations.Lock(context.Background(), request.Target)
	if err != nil {
		t.Fatal(err)
	}
	if err := lease.CheckIdle(); err != nil {
		t.Fatalf("non-destructive preflight failure blocked ordinary start: %v", err)
	}
	lease.Close()
	native.preflightErr = nil
	completed, err := r.Restore(context.Background(), request, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	if completed.NativeID == predecessor || completed.NativeID != native.current.ID || native.removes != 1 || native.imports != 1 {
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

func TestCheckpointRestoreResumesAfterDestructiveFailure(t *testing.T) {
	r, request, native, _ := recoveryHarness(t)
	native.importErr = errors.New("native import failed")
	if _, err := r.Restore(context.Background(), request, uuid.NewString()); err == nil {
		t.Fatal("import failure was hidden")
	}
	if native.current != nil || native.removes != 1 {
		t.Fatal("test did not cross the destructive boundary")
	}
	lease, err := r.Operations.Lock(context.Background(), request.Target)
	if err != nil {
		t.Fatal(err)
	}
	if err := lease.CheckIdle(); err == nil {
		t.Fatal("unfinished replacement allowed ordinary start")
	}
	lease.Close()
	native.importErr = nil
	r.Operations = Operations{Root: r.Operations.Root}
	result, err := r.Restore(context.Background(), request, uuid.NewString())
	if err != nil || native.current == nil || result.NativeID != native.current.ID || native.removes != 1 || native.imports != 2 {
		t.Fatalf("retry did not resume import: %#v %v", result, err)
	}
}

func TestCheckpointRestoreAdoptsNativeCommittedBeforeReceipt(t *testing.T) {
	r, request, native, store := recoveryHarness(t)
	native.importErr, native.commitThenErr = errors.New("native result was lost"), true
	if _, err := r.Restore(context.Background(), request, uuid.NewString()); err == nil {
		t.Fatal("missing native result should leave a retryable operation")
	}
	accepted := native.current.ID
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
