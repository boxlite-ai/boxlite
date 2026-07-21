//go:build boxlite_dev

// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"context"
	"testing"

	"github.com/boxlite-ai/runner/pkg/api/dto"
)

func boolPtr(b bool) *bool { return &b }

// A CREATE_BOX job can be replayed against the same runner — e.g. the host
// rebooted between persisting the box locally and the job being marked
// COMPLETED, so the poller re-executes the still-IN_PROGRESS job. Because the
// local box name is the control plane's globally-unique box id, a plain
// runtime.Create on replay hits "box with name '<id>' already exists" in
// boxlite-core, which the API surfaces to the user as a 400.
//
// Client.Create now routes through runtime.GetOrCreate, so a replay adopts the
// existing box instead of failing. This test reproduces the replay: it creates
// a box, then calls Create again with the SAME dto.Id, and asserts the second
// call succeeds and returns the same container id.
//
// SkipStart keeps the box at Configured so the assertion isolates the
// create/adopt path (no VM boot, no network), which is exactly where the
// duplicate-name error originated.
func TestIntegrationCreateBoxIdempotentOnReplay(t *testing.T) {
	ctx := context.Background()

	client, err := NewClient(ctx, ClientConfig{HomeDir: t.TempDir(), VolumeBucketPrefix: "boxlite-test-volume-"})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })

	createDto := dto.CreateBoxDTO{
		Id:           "replay-idempotency-box",
		Image:        "alpine:latest",
		OsUser:       "root",
		CpuQuota:     1,
		MemoryQuota:  1,
		StorageQuota: 1,
		SkipStart:    boolPtr(true),
	}

	firstID, _, err := client.Create(ctx, createDto)
	if err != nil {
		// Pulling the image / preparing the box is an infrastructure
		// prerequisite, not the behavior under test — skip rather than fail
		// when it is unavailable (mirrors the SDK integration tests).
		t.Skipf("first create could not complete (infrastructure prerequisite): %v", err)
	}

	// The replay: same dto.Id, box already persisted locally.
	secondID, _, err := client.Create(ctx, createDto)
	if err != nil {
		t.Fatalf("replayed Create must adopt the existing box, got error: %v", err)
	}
	if secondID != firstID {
		t.Fatalf("replayed Create must return the same container id: first=%q second=%q", firstID, secondID)
	}
}
