//go:build boxlite_dev

// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"context"
	"errors"
	"testing"
	"time"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/models/enums"
)

// A preview request to a stopped box used to boot it from inside the guest-port
// dial, behind the control plane's back. The dial must refuse the box
// and leave it stopped, so the proxy wakes it through the API instead.
func TestIntegrationDialGuestPortRefusesStoppedBoxWithoutBooting(t *testing.T) {
	ctx := context.Background()

	client, err := NewClient(ctx, ClientConfig{HomeDir: t.TempDir()})
	if err != nil {
		skipOrFailRuntimeStart(t, err)
	}
	t.Cleanup(func() { _ = client.Close() })

	createDto := dto.CreateBoxDTO{
		Id:           "dial-stopped-box",
		Image:        "alpine:latest",
		OsUser:       "root",
		CpuQuota:     1,
		MemoryQuota:  1,
		StorageQuota: 1,
		// Stops itself, like a box the AutoStop sweeper has reaped.
		Entrypoint: []string{"/bin/sh", "-c", "sleep 3"},
	}
	if _, _, err := client.Create(ctx, createDto); err != nil {
		t.Skipf("create could not complete (infrastructure prerequisite): %v", err)
	}
	waitForBoxState(ctx, t, client, createDto.Id, enums.BoxStateStopped)

	conn, err := client.DialGuestPort(ctx, createDto.Id, 8080)
	if conn != nil {
		conn.Close()
	}
	if !errors.Is(err, ErrBoxNotRunning) {
		t.Fatalf("DialGuestPort on a stopped box: err = %v, want ErrBoxNotRunning", err)
	}

	// A boot takes about a second; give one time to show up.
	time.Sleep(3 * time.Second)
	info, err := client.GetBoxInfo(ctx, createDto.Id)
	if err != nil {
		t.Fatalf("GetBoxInfo: %v", err)
	}
	if info.BoxState != enums.BoxStateStopped {
		t.Fatalf("box state after dial = %s, want %s (the dial booted the box)", info.BoxState, enums.BoxStateStopped)
	}
}

// A stop can land after DialGuestPort has seen the box running but before it
// fetches a handle. The dial must refuse rather than bring the box back through
// a fresh handle, or the box serves while the control plane records it as
// stopped.
func TestIntegrationDialGuestPortDoesNotBootABoxStoppedAfterTheCheck(t *testing.T) {
	ctx := context.Background()

	client, err := NewClient(ctx, ClientConfig{HomeDir: t.TempDir()})
	if err != nil {
		skipOrFailRuntimeStart(t, err)
	}
	t.Cleanup(func() { _ = client.Close() })

	createDto := dto.CreateBoxDTO{
		Id:           "dial-stop-race-box",
		Image:        "alpine:latest",
		OsUser:       "root",
		CpuQuota:     1,
		MemoryQuota:  1,
		StorageQuota: 1,
		Entrypoint:   []string{"/bin/sh", "-c", "sleep 600"},
	}
	if _, _, err := client.Create(ctx, createDto); err != nil {
		t.Skipf("create could not complete (infrastructure prerequisite): %v", err)
	}
	waitForBoxState(ctx, t, client, createDto.Id, enums.BoxStateStarted)

	// The control plane's stop, arriving between the check and the tunnel.
	client.afterGuestStateCheck = func(boxID string) {
		if err := client.Stop(ctx, boxID, false); err != nil {
			t.Errorf("Stop: %v", err)
		}
	}

	conn, err := client.DialGuestPort(ctx, createDto.Id, 8080)
	if conn != nil {
		conn.Close()
	}
	if !errors.Is(err, ErrBoxNotRunning) {
		t.Fatalf("DialGuestPort on a box stopped after its state check: err = %v, want ErrBoxNotRunning", err)
	}

	// A boot takes about a second; give one time to show up.
	time.Sleep(3 * time.Second)
	info, err := client.GetBoxInfo(ctx, createDto.Id)
	if err != nil {
		t.Fatalf("GetBoxInfo: %v", err)
	}
	if info.BoxState != enums.BoxStateStopped {
		t.Fatalf("box state after dial = %s, want %s (the dial booted the box)", info.BoxState, enums.BoxStateStopped)
	}
}

// A paused box is frozen for a snapshot. Handing out a tunnel to it leaves the
// preview request waiting on a guest that cannot answer.
func TestGuestDialableRefusesAPausedBox(t *testing.T) {
	for _, tc := range []struct {
		state boxlite.State
		want  bool
	}{
		{boxlite.StateRunning, true},
		{boxlite.StatePaused, false},
		{boxlite.StateStopped, false},
	} {
		if got := guestDialable(tc.state); got != tc.want {
			t.Errorf("guestDialable(%s) = %v, want %v", tc.state, got, tc.want)
		}
	}
}
