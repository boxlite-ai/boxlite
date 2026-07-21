// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

package boxlite

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"testing"

	sdkboxlite "github.com/boxlite-ai/boxlite/sdks/go"
)

func newTestStore(t *testing.T) *fileExecStore {
	t.Helper()
	store, err := NewFileExecStore(filepath.Join(t.TempDir(), "execs"))
	if err != nil {
		t.Fatalf("NewFileExecStore: %v", err)
	}
	return store
}

func TestFileExecStore_SaveListDelete(t *testing.T) {
	store := newTestStore(t)

	a := ExecRecord{ExecID: "aaaa", BoxID: "box1", TTY: true, CreatedUnix: 100}
	b := ExecRecord{ExecID: "bbbb", BoxID: "box2", TTY: false, CreatedUnix: 200}
	if err := store.Save(a); err != nil {
		t.Fatalf("Save a: %v", err)
	}
	if err := store.Save(b); err != nil {
		t.Fatalf("Save b: %v", err)
	}

	got, err := store.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	sort.Slice(got, func(i, j int) bool { return got[i].ExecID < got[j].ExecID })
	if len(got) != 2 || got[0] != a || got[1] != b {
		t.Fatalf("List round-trip mismatch: %+v", got)
	}

	if err := store.Delete("aaaa"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	got, err = store.List()
	if err != nil {
		t.Fatalf("List after delete: %v", err)
	}
	if len(got) != 1 || got[0] != b {
		t.Fatalf("expected only b after delete, got %+v", got)
	}

	// Deleting a missing record is a no-op, not an error.
	if err := store.Delete("aaaa"); err != nil {
		t.Fatalf("Delete missing should be nil, got %v", err)
	}
}

func TestFileExecStore_SaveOverwrites(t *testing.T) {
	store := newTestStore(t)
	if err := store.Save(ExecRecord{ExecID: "x", BoxID: "b", TTY: false, CreatedUnix: 1}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := store.Save(ExecRecord{ExecID: "x", BoxID: "b", TTY: true, CreatedUnix: 2}); err != nil {
		t.Fatalf("Save overwrite: %v", err)
	}
	got, err := store.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 1 || !got[0].TTY || got[0].CreatedUnix != 2 {
		t.Fatalf("overwrite not reflected: %+v", got)
	}
}

func TestFileExecStore_ListSkipsCorrupt(t *testing.T) {
	store := newTestStore(t)
	if err := store.Save(ExecRecord{ExecID: "good", BoxID: "b", CreatedUnix: 1}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	// A truncated / non-JSON file must not strand the valid siblings.
	if err := os.WriteFile(filepath.Join(store.dir, "bad.json"), []byte("{not json"), 0o600); err != nil {
		t.Fatalf("write corrupt: %v", err)
	}
	got, err := store.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 1 || got[0].ExecID != "good" {
		t.Fatalf("expected only the good record, got %+v", got)
	}
}

func TestFileExecStore_RejectsUnsafeID(t *testing.T) {
	store := newTestStore(t)
	if err := store.Save(ExecRecord{ExecID: "../escape", BoxID: "b"}); err == nil {
		t.Fatal("expected Save to reject a path-traversal exec id")
	}
	// Nothing should have been written outside the store dir.
	if _, err := os.Stat(filepath.Join(store.dir, "..", "escape.json")); !os.IsNotExist(err) {
		t.Fatalf("unsafe id escaped the store dir: %v", err)
	}
}

// fakeBoxFetcher always fails GetBox, standing in for a box that did not
// survive the restart (or a RecoverBox destroy/recreate).
type fakeBoxFetcher struct{ err error }

func (f fakeBoxFetcher) GetBox(_ context.Context, _ string) (*sdkboxlite.Box, error) {
	return nil, f.err
}

// TestRecover_DropsStaleWhenBoxMissing verifies Recover does not leak records
// for boxes that no longer exist: a stale entry is deleted so it can't be
// retried forever and can't strand recovery of live siblings.
func TestRecover_DropsStaleWhenBoxMissing(t *testing.T) {
	store := newTestStore(t)
	if err := store.Save(ExecRecord{ExecID: "gone", BoxID: "dead-box", CreatedUnix: 1}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	m := NewExecManager()
	defer m.Stop()
	m.SetStore(store)

	m.Recover(context.Background(), fakeBoxFetcher{err: errors.New("box not found")})

	got, err := store.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected stale record dropped, got %+v", got)
	}
	if _, ok := m.Get("gone"); ok {
		t.Fatal("stale exec should not be registered after failed recovery")
	}
}

// TestRecover_NoStoreIsNoop guards the nil-store default (tests, or a runner
// with persistence disabled): Recover must not panic and must do nothing.
func TestRecover_NoStoreIsNoop(t *testing.T) {
	m := NewExecManager()
	defer m.Stop()
	m.Recover(context.Background(), fakeBoxFetcher{err: errors.New("unused")})
}
