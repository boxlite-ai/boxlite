//go:build boxlite_dev

// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/cmd/runner/config"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/checkpoint"
	"github.com/containerd/errdefs"
)

func TestProtectedRetirementReplaysAfterRunnerReopen(t *testing.T) {
	ctx := t.Context()
	t.Setenv("ENVIRONMENT", "development")
	t.Setenv("BOXLITE_API_URL", "http://127.0.0.1:1")
	t.Setenv("BOXLITE_RUNNER_TOKEN", "fixture-token")
	t.Setenv("RUNNER_DOMAIN", "127.0.0.1")
	settings, err := config.GetConfig()
	if err != nil {
		t.Fatal(err)
	}
	previousEnvironment := settings.Environment
	settings.Environment = "development"
	t.Cleanup(func() { settings.Environment = previousEnvironment })
	home := t.TempDir()
	open := func() *Client {
		client, err := NewClient(ctx, ClientConfig{HomeDir: home})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = client.Close() })
		return client
	}
	const boxID = "597da250-c3f6-4276-a0c2-25657a8fdeda"
	const attempt = "1eaf8827-d376-4736-acf0-63d6c57b934d"
	key := json.RawMessage(`{"runner_id":"8137cc0d-5d3f-43b8-aa32-b9304740269e","attempt_id":"` + attempt + `","registration_id":"fixture-registration","registration_revision":"7","policy":{"revision":"fixture-policy","policy":{"mode":"disabled","allow_net":[]}}}`)
	box := dto.CreateBoxDTO{Id: boxID, Image: "alpine:latest", CpuQuota: cpuQuota(1), MemoryQuota: 1, StorageQuota: 1}
	client := open()
	nativeID, err := client.AllocateProtectedPlaceholder(ctx, box, ProtectedPreparation{
		AttemptID: attempt, Fingerprint: "fixture-prepare", Authorize: func(context.Context) error { return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	name := (checkpoint.ProtectedAllocation{BoxID: boxID, AttemptID: attempt}).NativeName()
	record := filepath.Join(getVolumeMountRecordDir(), name+".json")
	t.Cleanup(func() { _ = os.Remove(record) })
	if err := client.recordBoxVolumeMounts(ctx, name, []volumeMount{{rootPath: t.TempDir()}}); err != nil {
		t.Fatal(err)
	}
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}

	client = open()
	native, err := client.runtime.Get(ctx, nativeID)
	if err != nil {
		t.Fatal(err)
	}
	if err := native.Start(ctx); !sdk.IsInvalidState(err) {
		native.Close()
		t.Fatalf("ordinary native start reached the protected allocation: %v", err)
	}
	if _, err := native.Exec(ctx, "/bin/true"); !sdk.IsInvalidState(err) {
		native.Close()
		t.Fatalf("ordinary native exec reached the protected allocation: %v", err)
	}
	source := filepath.Join(t.TempDir(), "probe")
	if err := os.WriteFile(source, []byte("probe"), 0600); err != nil {
		native.Close()
		t.Fatal(err)
	}
	if err := native.CopyInto(ctx, source, "/probe"); !sdk.IsInvalidState(err) {
		native.Close()
		t.Fatalf("ordinary native file copy reached the protected allocation: %v", err)
	}
	native.Close()

	// Capture the crash boundary after Runtime retired the attempt and deleted
	// the native Box, while the Runner still owes volume-record cleanup.
	lease, err := client.checkpointOperations().Lock(ctx, boxID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lease.Close() })
	native, err = client.runtime.Get(ctx, nativeID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = native.Close() })
	proof, err := native.RunnerProtectedBoot(ctx, sdk.ProtectedStopAndRetire, key)
	if err != nil {
		t.Fatal(err)
	}
	if err := lease.SaveProtectedRetirement(attempt, checkpoint.ProtectedRetirement{
		NativeID: nativeID, Receipt: proof,
	}); err != nil {
		t.Fatal(err)
	}
	if err := lease.CloseProtectedAllocation(attempt); err != nil {
		t.Fatal(err)
	}
	if _, err := native.RunnerProtectedBoot(ctx, sdk.ProtectedRemoveRetiredAllocation, proof); err != nil {
		t.Fatal(err)
	}
	native.Close()
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(record); err != nil {
		t.Fatalf("crash fixture must retain the volume record: %v", err)
	}
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}

	client = open()
	grant := func(_ context.Context, current string) (ProtectedBootAdmission, error) {
		if current != "" && current != nativeID {
			t.Fatalf("retirement saw different native identity: %q", current)
		}
		return ProtectedBootAdmission{NativeID: nativeID, StartClaimed: true}, nil
	}
	receipt, err := client.AuthorizedProtectedBoot(ctx, boxID, attempt, sdk.ProtectedBootRetire, key, grant)
	if err != nil {
		t.Fatal(err)
	}
	var evidence protectedEvidence
	if err := json.Unmarshal(receipt, &evidence); err != nil || evidence.Outcome != "retired" ||
		!evidence.AllocationClosed || !evidence.NoSpawn || evidence.Epoch != nil || evidence.NativeID != nativeID {
		t.Fatalf("incorrect no-spawn evidence: %s, %v", receipt, err)
	}
	if _, err := os.Stat(record); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("volume ownership survived retirement: %v", err)
	}
	if _, err := client.runtime.GetInfo(ctx, nativeID); !sdk.IsNotFound(err) {
		t.Fatalf("native Box survived retirement: %v", err)
	}
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}

	client = open()
	replay, err := client.AuthorizedProtectedBoot(ctx, boxID, attempt, sdk.ProtectedBootRetire, key, grant)
	if err != nil || string(replay) != string(receipt) {
		t.Fatalf("replayed retirement = %s, %v, want %s", replay, err, receipt)
	}
	if _, err := client.AllocateProtectedPlaceholder(ctx, box, ProtectedPreparation{
		AttemptID: attempt, Fingerprint: "fixture-prepare", Authorize: func(context.Context) error { return nil },
	}); err == nil {
		t.Fatal("late preparation reopened a retired allocation")
	}
}

func TestProtectedPreparationDoesNotConsumeRunnerShutdownDeadline(t *testing.T) {
	t.Setenv("ENVIRONMENT", "development")
	t.Setenv("BOXLITE_API_URL", "http://127.0.0.1:1")
	t.Setenv("BOXLITE_RUNNER_TOKEN", "fixture-token")
	t.Setenv("RUNNER_DOMAIN", "127.0.0.1")
	settings, err := config.GetConfig()
	if err != nil {
		t.Fatal(err)
	}
	previousEnvironment := settings.Environment
	settings.Environment = "development"
	t.Cleanup(func() { settings.Environment = previousEnvironment })

	bin := t.TempDir()
	signal := filepath.Join(bin, "mount-started")
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("PROTECTED_PREPARATION_MOUNT_STARTED", signal)
	if err := os.WriteFile(filepath.Join(bin, "mountpoint"), []byte(
		"#!/bin/sh\ntouch \"$PROTECTED_PREPARATION_MOUNT_STARTED\"\nexec /bin/sleep 30\n",
	), 0700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	client, err := NewClient(ctx, ClientConfig{HomeDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })

	const boxID = "2d683475-d4ec-4df2-b3cc-90ad7db58122"
	const attempt = "a51ff779-b779-46a7-a4d6-006b428fbf05"
	request := dto.CreateBoxDTO{
		Id: boxID, Image: "alpine:latest", CpuQuota: cpuQuota(1), MemoryQuota: 1, StorageQuota: 1,
		Volumes: []dto.VolumeDTO{{VolumeId: "fixture-blocked-shutdown", MountPath: "/data"}},
	}
	preparation := ProtectedPreparation{
		AttemptID: attempt, Fingerprint: "fixture-prepare", Authorize: func(context.Context) error { return nil },
	}
	name := (checkpoint.ProtectedAllocation{BoxID: boxID, AttemptID: attempt}).NativeName()
	t.Cleanup(func() { _ = os.Remove(filepath.Join(getVolumeMountRecordDir(), name+".json")) })
	prepared := make(chan error, 1)
	go func() {
		_, err := client.AllocateProtectedPlaceholder(ctx, request, preparation)
		prepared <- err
	}()
	for {
		if _, err := os.Stat(signal); err == nil {
			break
		}
		select {
		case err := <-prepared:
			t.Fatalf("preparation exited before the mount probe: %v", err)
		case <-ctx.Done():
			t.Fatal("volume mount did not start")
		case <-time.After(10 * time.Millisecond):
		}
	}

	shutdownContext, cancelShutdown := context.WithTimeout(t.Context(), 500*time.Millisecond)
	defer cancelShutdown()
	stopped := make(chan error, 1)
	go func() { stopped <- client.Shutdown(shutdownContext, 400*time.Millisecond) }()
	select {
	case err := <-stopped:
		if err != nil {
			t.Fatalf("native graceful shutdown did not complete: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("blocked mount kept Runner shutdown waiting")
	}
	select {
	case err := <-prepared:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("expected protected preparation to be cancelled, got %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("protected preparation did not stop")
	}
	if _, err := client.AllocateProtectedPlaceholder(t.Context(), request, preparation); !errdefs.IsUnavailable(err) {
		t.Fatalf("Runner accepted preparation after shutdown: %v", err)
	}
	_, err = client.AuthorizedProtectedBoot(t.Context(), boxID, attempt, sdk.ProtectedBootStart,
		nil, func(context.Context, string) (ProtectedBootAdmission, error) {
			t.Error("Runner requested a start grant after shutdown")
			return ProtectedBootAdmission{}, nil
		})
	if !errdefs.IsUnavailable(err) {
		t.Fatalf("Runner accepted protected startup after shutdown: %v", err)
	}
}

func TestOrdinaryVolumeMountHoldsCleanupExclusionUntilRecorded(t *testing.T) {
	client, ctx := newVolumePreparationTestClient(t)
	bin := t.TempDir()
	probe := filepath.Join(bin, "started")
	release := filepath.Join(bin, "release")
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("RUNNER_TEST_VOLUME_PROBE", probe)
	t.Setenv("RUNNER_TEST_VOLUME_RELEASE", release)
	if err := os.WriteFile(filepath.Join(bin, "mountpoint"), []byte(
		"#!/bin/sh\ntouch \"$RUNNER_TEST_VOLUME_PROBE\"\nwhile [ ! -f \"$RUNNER_TEST_VOLUME_RELEASE\" ]; do sleep 0.01; done\n",
	), 0700); err != nil {
		t.Fatal(err)
	}

	const boxID = "ordinary-shutdown-mount-test"
	record := filepath.Join(getVolumeMountRecordDir(), boxID+".json")
	t.Cleanup(func() { _ = os.Remove(record) })
	volume := dto.VolumeDTO{VolumeId: "fixture-ordinary-mount", MountPath: "/data"}
	prepared := make(chan error, 1)
	go func() {
		_, err := client.prepareBoxVolumeMounts(ctx, boxID, []dto.VolumeDTO{volume}, false)
		prepared <- err
	}()
	for {
		if _, err := os.Stat(probe); err == nil {
			break
		}
		select {
		case err := <-prepared:
			t.Fatalf("ordinary preparation exited before the probe: %v", err)
		case <-ctx.Done():
			t.Fatal("ordinary mount probe did not start")
		case <-time.After(10 * time.Millisecond):
		}
	}
	if client.volumeCleanupMutex.TryLock() {
		client.volumeCleanupMutex.Unlock()
		t.Error("orphan cleanup could run before ordinary volume ownership was recorded")
	}
	if err := os.WriteFile(release, nil, 0600); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-prepared:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("ordinary volume preparation did not finish")
	}
	recorded, err := client.getRecordedVolumeMounts()
	if err != nil || !recorded[volumeRootPath(volume.VolumeId)] {
		t.Fatalf("ordinary volume ownership was not recorded: %v", err)
	}
}

func TestProtectedVolumePreparationCancelsWhileWaitingForMountLocks(t *testing.T) {
	client, ctx := newVolumePreparationTestClient(t)
	const volumeID = "fixture-contended-mount"
	volume := dto.VolumeDTO{VolumeId: volumeID, MountPath: "/data"}
	sameVolume := &sync.Mutex{}
	client.volumeMutexes[volumeMountPrefix+volumeID] = sameVolume
	for _, tc := range []struct {
		name string
		lock *sync.Mutex
	}{
		{"ownership", &client.volumeCleanupMutex},
		{"same volume", sameVolume},
	} {
		t.Run(tc.name, func(t *testing.T) {
			const boxID = "protected-shutdown-mount-test"
			record := filepath.Join(getVolumeMountRecordDir(), boxID+".json")
			t.Cleanup(func() { _ = os.Remove(record) })

			tc.lock.Lock()
			defer tc.lock.Unlock()
			waitCtx, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
			defer cancel()
			prepared := make(chan error, 1)
			go func() {
				_, err := client.prepareBoxVolumeMounts(waitCtx, boxID, []dto.VolumeDTO{volume}, true)
				prepared <- err
			}()
			select {
			case err := <-prepared:
				if !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("protected preparation returned %v, want context deadline", err)
				}
			case <-time.After(time.Second):
				tc.lock.Unlock()
				<-prepared
				tc.lock.Lock()
				t.Fatal("protected preparation waited past cancellation for the volume lock")
			}
		})
	}
}

func newVolumePreparationTestClient(t *testing.T) (*Client, context.Context) {
	t.Helper()
	t.Setenv("ENVIRONMENT", "development")
	t.Setenv("BOXLITE_API_URL", "http://127.0.0.1:1")
	t.Setenv("BOXLITE_RUNNER_TOKEN", "fixture-token")
	t.Setenv("RUNNER_DOMAIN", "127.0.0.1")
	settings, err := config.GetConfig()
	if err != nil {
		t.Fatal(err)
	}
	previousEnvironment := settings.Environment
	settings.Environment = "development"
	t.Cleanup(func() { settings.Environment = previousEnvironment })

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	t.Cleanup(cancel)
	client := &Client{logger: testClient(t).logger, volumeMutexes: make(map[string]*sync.Mutex)}
	return client, ctx
}
