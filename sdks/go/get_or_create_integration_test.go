//go:build boxlite_dev

// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"context"
	"errors"
	"testing"
)

// TestIntegrationGetOrCreateReportsCreatedFlag proves the created flag the FFI
// now carries back actually reaches the Go caller and reflects reality: the
// first GetOrCreate of a name creates the box (created=true), a second
// GetOrCreate of the SAME name adopts it (created=false) and returns the same
// box id.
//
// This is a real cross-boundary test: created originates in boxlite-core's
// get_or_create, travels the C FFI callback (the bool added in this change),
// and is asserted on the Go side — nothing in the test body fabricates it.
func TestIntegrationGetOrCreateReportsCreatedFlag(t *testing.T) {
	rt := newTestRuntime(t)
	ctx := context.Background()
	const name = "get-or-create-created-flag-box"

	first, created, err := rt.GetOrCreate(ctx, "alpine:latest", WithName(name), WithAutoRemove(false))
	if err != nil {
		// Image pull / prepare is an infrastructure prerequisite, not the
		// behavior under test — skip rather than fail when unavailable.
		var e *Error
		if errors.As(err, &e) && (e.Code == ErrStorage || e.Code == ErrImage || e.Code == ErrNetwork) {
			t.Skipf("infrastructure prerequisite unavailable (code=%d): %v", e.Code, err)
		}
		t.Fatalf("first GetOrCreate: %v", err)
	}
	t.Cleanup(func() {
		_ = rt.ForceRemove(ctx, first.ID())
		_ = first.Close()
	})
	if !created {
		t.Fatalf("first GetOrCreate of a fresh name must report created=true, got false")
	}

	second, created, err := rt.GetOrCreate(ctx, "alpine:latest", WithName(name), WithAutoRemove(false))
	if err != nil {
		t.Fatalf("second GetOrCreate must adopt the existing box, got error: %v", err)
	}
	defer func() { _ = second.Close() }()
	if created {
		t.Fatalf("second GetOrCreate of an existing name must report created=false (adopted), got true")
	}
	if second.ID() != first.ID() {
		t.Fatalf("adopted box must have the same id: first=%q second=%q", first.ID(), second.ID())
	}
}
