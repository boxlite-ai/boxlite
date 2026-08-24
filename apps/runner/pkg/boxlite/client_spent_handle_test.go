//go:build boxlite_dev

// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"context"
	"testing"
	"time"

	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/models/enums"
)

// A box can stop *itself*: its main command exits and the guest powers the VM
// off. The handle the runner cached while the box was up is spent from that
// moment — it still holds the dead VM and can never boot another — so serving
// it back answers every later call with a corpse, for the life of the runner
// process. Client.Stop evicts its own handle, so only the self-stop left the
// cache poisoned, and the failure surfaced on the dashboard as
// "handle is spent" (BoxLite error code 11) when a user pressed Start.
//
// This reproduces it end to end: Create caches a handle and starts a box whose
// entrypoint exits on its own, then the dashboard's Start comes back to it.
func TestIntegrationSelfStoppedBoxRestartsAfterCachedHandleGoesSpent(t *testing.T) {
	ctx := context.Background()

	client, err := NewClient(ctx, ClientConfig{HomeDir: t.TempDir()})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })

	createDto := dto.CreateBoxDTO{
		Id:           "spent-handle-restart-box",
		Image:        "alpine:latest",
		OsUser:       "root",
		CpuQuota:     1,
		MemoryQuota:  1,
		StorageQuota: 1,
		// Short enough that the box stops itself promptly, long enough that the
		// restart below observes a booted box rather than racing a second exit.
		Entrypoint: []string{"/bin/sh", "-c", "sleep 3"},
	}

	if _, _, err := client.Create(ctx, createDto); err != nil {
		// Pulling the image / booting the VM is an infrastructure prerequisite,
		// not the behavior under test (mirrors the sibling integration tests).
		t.Skipf("create could not complete (infrastructure prerequisite): %v", err)
	}
	// No Destroy on cleanup: it reaches for the runner's process-wide config,
	// which only the runner binary populates. The box lives in this test's
	// throwaway home dir, and Close releases the runtime that holds it.

	// Create cached the handle (client.go, right after runtime.GetOrCreate) and
	// started the box; the entrypoint now exits on its own. Polling only reads
	// state — it is how the control plane learns the box went down.
	waitForBoxState(ctx, t, client, createDto.Id, enums.BoxStateStopped)

	// The dashboard's Start button. The cached handle is spent by now, so this
	// only succeeds if the cache hands back a fresh one.
	if _, err := client.Start(ctx, createDto.Id, nil, nil); err != nil {
		t.Fatalf("restarting a self-stopped box must succeed, got: %v", err)
	}

	waitForBoxState(ctx, t, client, createDto.Id, enums.BoxStateStarted)
}

// waitForBoxState polls the runner's own state accessor — the call the control
// plane makes — until the box reaches want, failing the test if it never does.
func waitForBoxState(ctx context.Context, t *testing.T, client *Client, boxId string, want enums.BoxState) {
	t.Helper()

	deadline := time.Now().Add(60 * time.Second)
	var last enums.BoxState
	for time.Now().Before(deadline) {
		state, err := client.GetBoxState(ctx, boxId)
		if err != nil {
			t.Fatalf("GetBoxState(%s): %v", boxId, err)
		}
		if state == want {
			return
		}
		last = state
		time.Sleep(250 * time.Millisecond)
	}
	t.Fatalf("box %s never reached %s (last seen %s)", boxId, want, last)
}
