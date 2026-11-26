// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package checkpoint

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestProtectedAllocationJournalPersistsClosure(t *testing.T) {
	const target = "AllocatedBox"
	const first = "8b661a4a-8a64-4d78-9dcb-094ed78c155c"
	const second = "6288c8a0-248f-4545-8afd-76d3fbc67b2e"
	operations := Operations{Root: filepath.Join(t.TempDir(), "targets")}
	lease, err := operations.Lock(context.Background(), target)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lease.Close() })
	owner := ProtectedAllocation{BoxID: target, AttemptID: first, CreatorPID: os.Getpid()}
	if err := lease.SaveProtectedAllocation(owner); err != nil {
		t.Fatal(err)
	}
	if err := lease.CloseProtectedAllocation(first); err != nil {
		t.Fatal(err)
	}
	if err := lease.ClearProtectedAllocation(); err != nil {
		t.Fatal(err)
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}

	reopened := Operations{Root: operations.Root}
	current, err := reopened.Lock(context.Background(), target)
	if err != nil {
		t.Fatal(err)
	}
	defer current.Close()
	if closed, err := current.ProtectedAllocationClosed(first); err != nil || !closed {
		t.Fatalf("original attempt closure = %t, %v", closed, err)
	}
	if closed, err := current.ProtectedAllocationClosed(second); err != nil || closed {
		t.Fatalf("replacement attempt closure = %t, %v", closed, err)
	}
	replacement := ProtectedAllocation{BoxID: target, AttemptID: second, CreatorPID: os.Getpid()}
	if err := current.SaveProtectedAllocation(replacement); err != nil {
		t.Fatal(err)
	}
	if replacement.NativeName() == owner.NativeName() {
		t.Fatal("distinct attempts share the same native name")
	}
	if loaded, err := reopened.ProtectedAllocation(target); err != nil || loaded == nil || *loaded != replacement {
		t.Fatalf("read replacement outside the target lease = %+v, %v", loaded, err)
	}
}
