// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

//go:build boxlite_dev

package boxlite

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/checkpoint"
	"github.com/containerd/errdefs"
	"github.com/google/uuid"
)

func TestOrdinaryExistingNameInReservedNamespaceRemainsUsable(t *testing.T) {
	useDevelopmentVolumeDirectory(t)
	ctx := t.Context()
	client, err := NewClient(ctx, ClientConfig{HomeDir: t.TempDir(), VolumeCleanupDryRun: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	name := checkpoint.ProtectedAllocationPrefix + "0123456789abcdef0123456789abcdef"
	box, err := client.runtime.Create(ctx, "alpine:latest", sdk.WithName(name), sdk.WithAutoRemove(false))
	if err != nil {
		t.Fatal(err)
	}
	ordinaryID := box.ID()
	box.Close()
	listed, err := client.ListInfo(ctx)
	if err != nil || !slices.ContainsFunc(listed, func(info sdk.BoxInfo) bool { return info.ID == ordinaryID && info.Name == name }) {
		t.Errorf("existing ordinary Box must remain visible: %v", err)
	}
	if _, err := client.GetBox(ctx, name); err != nil {
		t.Errorf("existing ordinary Box must remain accessible: %v", err)
	}
	stop, outbound := true, false
	request := dto.CreateBoxDTO{
		Id: name, Image: "alpine:latest", MemoryQuota: 1, StorageQuota: 1,
		SkipStart: &stop, OutboundEnabled: &outbound,
	}
	if got, _, err := client.Create(ctx, request); err != nil || got != ordinaryID {
		t.Errorf("existing ordinary Box must support create replay: %q (%v)", got, err)
	}
	if err := client.Destroy(ctx, name); err != nil {
		t.Errorf("existing ordinary Box must support deletion: %v", err)
	}
	request.Id = checkpoint.ProtectedAllocationPrefix + uuid.NewString()
	if _, _, err := client.Create(ctx, request); !errdefs.IsInvalidArgument(err) {
		t.Errorf("new ordinary creates must respect the reserved namespace: %v", err)
	}
}

func TestProtectedAllocationClosesExactAttemptAcrossRunnerRestart(t *testing.T) {
	useDevelopmentVolumeDirectory(t)
	ctx := t.Context()
	cfg := ClientConfig{HomeDir: t.TempDir(), VolumeCleanupDryRun: true}
	client, err := NewClient(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if client != nil {
			_ = client.Close()
		}
	})
	boxID, first, second := uuid.NewString(), uuid.NewString(), uuid.NewString()
	request := dto.CreateBoxDTO{Id: boxID, Image: "alpine:latest", MemoryQuota: 1, StorageQuota: 1}

	if err := client.CloseProtectedPlaceholder(ctx, boxID, first); err != nil {
		t.Fatalf("close before allocation: %v", err)
	}
	if _, err := client.AllocateProtectedPlaceholder(ctx, request, first); !errdefs.IsFailedPrecondition(err) {
		t.Fatalf("closed attempt must not allocate: %v", err)
	}
	nativeID, err := client.AllocateProtectedPlaceholder(ctx, request, second)
	if err != nil || nativeID == "" {
		t.Fatalf("allocate exact second attempt: %q, %v", nativeID, err)
	}
	if got, err := client.AllocateProtectedPlaceholder(ctx, request, second); err != nil || got != nativeID {
		t.Fatalf("duplicate must use %q, got %q: %v", nativeID, got, err)
	}
	if _, err := client.Start(ctx, boxID, nil, nil); !errors.Is(err, errProtectedBox) {
		t.Fatalf("ordinary Start must refuse the configured allocation: %v", err)
	}
	if _, err := client.Start(ctx, nativeID, nil, nil); !errors.Is(err, errProtectedBox) {
		t.Errorf("ordinary Start must refuse the native ID before preparing mounts: %v", err)
	}
	handle, err := client.runtime.Get(ctx, nativeID)
	if err != nil {
		t.Fatal(err)
	}
	err = handle.Start(ctx)
	handle.Close()
	if !sdk.IsInvalidState(err) {
		t.Fatalf("the common Runtime start path must also refuse the allocation: %v", err)
	}
	if err := client.Destroy(ctx, nativeID); !errors.Is(err, errProtectedBox) {
		t.Fatalf("ordinary destroy must refuse the native ID: %v", err)
	}
	checkpointBackend := nativeCheckpointRecovery{client: client, target: nativeID}
	if _, err := checkpointBackend.Lookup(ctx, nativeID); !errors.Is(err, errProtectedBox) {
		t.Fatalf("ordinary checkpoint recovery must refuse the native ID: %v", err)
	}
	setBooted := func(booted bool) {
		lease, err := client.checkpointOperations().Lock(ctx, boxID)
		if err != nil {
			t.Fatal(err)
		}
		defer lease.Close()
		allocation, err := lease.ProtectedAllocation()
		if err != nil || allocation == nil {
			t.Fatalf("missing exact allocation: %v", err)
		}
		allocation.Booted = booted
		allocation.BootAttempt = ""
		if booted {
			allocation.BootAttempt = second
		}
		if err := lease.SaveProtectedAllocation(*allocation); err != nil {
			t.Fatal(err)
		}
	}
	setBooted(true)
	if err := client.Destroy(ctx, boxID); !errors.Is(err, errProtectedBox) {
		t.Errorf("ordinary destroy must refuse the confirmed logical ID: %v", err)
	}
	setBooted(false)
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	client, err = NewClient(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.CloseProtectedPlaceholder(ctx, boxID, first); err != nil {
		t.Fatalf("replay closure for old attempt: %v", err)
	}
	if got, err := client.AllocateProtectedPlaceholder(ctx, request, second); err != nil || got != nativeID {
		t.Fatalf("old closure must retain the other allocation %q, got %q: %v", nativeID, got, err)
	}
	if err := client.CloseProtectedPlaceholder(ctx, boxID, second); err != nil {
		t.Fatalf("close the matching allocation: %v", err)
	}
	if _, err := client.runtime.GetInfo(ctx, nativeID); !sdk.IsNotFound(err) {
		t.Fatalf("closure must prove native absence: %v", err)
	}
}

func TestProtectedCloseRetainsMountReacquiredByOrdinaryStart(t *testing.T) {
	useDevelopmentVolumeDirectory(t)
	ctx := t.Context()
	client, err := NewClient(ctx, ClientConfig{HomeDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	protectedID, ordinaryID, attempt, volumeID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	mount := volumeRootPath(volumeID)
	if err := os.Mkdir(mount, 0700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(mount) })
	fixture := t.TempDir()
	t.Setenv("PATH", fixture+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("PR08_VOLUME_PATH", mount)
	t.Setenv("PR08_VOLUME_FIXTURE", fixture)
	for name, script := range map[string]string{
		"mountpoint": `#!/bin/sh
for arg do last="$arg"; done
[ "$last" = "$PR08_VOLUME_PATH" ] || exit 2
if [ -f "$PR08_VOLUME_FIXTURE/armed" ]; then
  : > "$PR08_VOLUME_FIXTURE/entered"
  until [ -f "$PR08_VOLUME_FIXTURE/resume" ]; do /bin/sleep 0.01; done
fi
exit 0
`,
		"umount": `#!/bin/sh
for arg do
  if [ "$arg" = "$PR08_VOLUME_PATH" ]; then : > "$PR08_VOLUME_FIXTURE/unmounted"; fi
done
exit 1
`,
	} {
		if err := os.WriteFile(filepath.Join(fixture, name), []byte(script), 0700); err != nil {
			t.Fatal(err)
		}
	}
	writeSignal := func(name string) error { return os.WriteFile(filepath.Join(fixture, name), nil, 0600) }
	t.Cleanup(func() { _ = writeSignal("resume") })
	t.Cleanup(func() { _ = client.removeBoxVolumeMountRecord(ctx, ordinaryID) })
	request := dto.CreateBoxDTO{
		Id: protectedID, Image: "alpine:latest", MemoryQuota: 1, StorageQuota: 1,
		Volumes: []dto.VolumeDTO{{VolumeId: volumeID, MountPath: "/work"}},
	}
	if _, err := client.AllocateProtectedPlaceholder(ctx, request, attempt); err != nil {
		t.Fatal(err)
	}
	owner := (checkpoint.ProtectedAllocation{BoxID: protectedID, AttemptID: attempt}).NativeName()
	t.Cleanup(func() { _ = client.removeBoxVolumeMountRecord(ctx, owner) })
	if err := writeSignal("armed"); err != nil {
		t.Fatal(err)
	}
	prepared := make(chan error, 1)
	go func() {
		prepared <- client.ensureVolumeMountsFromMetadata(ctx, ordinaryID, map[string]string{
			"volumes": `[{"volumeId":"` + volumeID + `","mountPath":"/work"}]`,
		})
	}()
	deadline := time.Now().Add(4 * time.Second)
	for {
		if _, err := os.Stat(filepath.Join(fixture, "entered")); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("ordinary Start did not begin reacquiring the shared volume")
		}
		time.Sleep(10 * time.Millisecond)
	}
	closed := make(chan error, 1)
	go func() { closed <- client.CloseProtectedPlaceholder(ctx, protectedID, attempt) }()
	protectedRecord := filepath.Join(getVolumeMountRecordDir(), owner+".json")
	for {
		if _, err := os.Stat(protectedRecord); errors.Is(err, os.ErrNotExist) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("exact close did not reach shared cleanup while ordinary Start was held")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := writeSignal("resume"); err != nil {
		t.Fatal(err)
	}
	if err := <-prepared; err != nil {
		t.Fatal(err)
	}
	if err := <-closed; err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(fixture, "unmounted")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("exact cleanup must retain the mount reused by ordinary Start: %v", err)
	}
	references, err := client.getRecordedVolumeMounts()
	if err != nil || !references[mount] {
		t.Fatalf("ordinary Start must retain its published mount reference: %v", err)
	}
}

func TestHistoricalRetirementReplayKeepsNewAllocationIntent(t *testing.T) {
	useDevelopmentVolumeDirectory(t)
	ctx := t.Context()
	client, err := NewClient(ctx, ClientConfig{HomeDir: t.TempDir(), VolumeCleanupDryRun: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	boxID, oldAttempt, newAttempt := uuid.NewString(), uuid.NewString(), uuid.NewString()
	stop, outbound := true, false
	if _, _, err := client.Create(ctx, dto.CreateBoxDTO{
		Id: boxID, Image: "alpine:latest", MemoryQuota: 1, StorageQuota: 1,
		SkipStart: &stop, OutboundEnabled: &outbound,
	}); err != nil {
		t.Fatal(err)
	}
	key := map[string]any{
		"runner_id": uuid.NewString(), "attempt_id": oldAttempt,
		"registration_id": nil, "registration_revision": nil,
		"policy": map[string]any{"revision": "initial", "policy": map[string]any{"mode": "disabled"}},
	}
	if _, err := client.ProtectedBoot(ctx, boxID, sdk.ProtectedBootRetire, key, nil); err != nil {
		t.Fatalf("retire the old stopped Box: %v", err)
	}
	removal := map[string]any{"key": key, "epoch": nil, "runner_box_name": boxID}
	if _, err := client.ProtectedBoot(ctx, boxID, sdk.ProtectedBootRemove, removal, nil); err != nil {
		t.Fatalf("remove the old retired Box: %v", err)
	}
	lease, err := client.checkpointOperations().Lock(ctx, boxID)
	if err != nil {
		t.Fatal(err)
	}
	err = lease.SaveProtectedAllocation(checkpoint.ProtectedAllocation{
		BoxID: boxID, AttemptID: newAttempt, CreatorPID: os.Getpid(), InFlight: true,
	})
	lease.Close()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.ProtectedBoot(ctx, boxID, sdk.ProtectedBootRemove, removal, nil); err != nil {
		t.Fatalf("read the exact historical removal receipt: %v", err)
	}
	owner, err := client.checkpointOperations().ProtectedAllocation(boxID)
	if err != nil || owner == nil || owner.AttemptID != newAttempt || !owner.InFlight {
		t.Fatalf("historical removal must preserve the newer allocation intent: %+v (%v)", owner, err)
	}
}

func TestUnconfirmedRestartRetirementClosesNativeAllocation(t *testing.T) {
	useDevelopmentVolumeDirectory(t)
	ctx := t.Context()
	client, err := NewClient(ctx, ClientConfig{HomeDir: t.TempDir(), VolumeCleanupDryRun: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	boxID, firstAttempt, restartAttempt := uuid.NewString(), uuid.NewString(), uuid.NewString()
	request := dto.CreateBoxDTO{Id: boxID, Image: "alpine:latest", MemoryQuota: 1, StorageQuota: 1}
	nativeID, err := client.AllocateProtectedPlaceholder(ctx, request, firstAttempt)
	if err != nil {
		t.Fatal(err)
	}
	lease, err := client.checkpointOperations().Lock(ctx, boxID)
	if err != nil {
		t.Fatal(err)
	}
	owner, err := lease.ProtectedAllocation()
	if err != nil || owner == nil {
		lease.Close()
		t.Fatalf("read prior allocation: %v", err)
	}
	// Model the Runner journal after the previous boot was confirmed.
	owner.Booted, owner.BootAttempt = true, firstAttempt
	err = lease.SaveProtectedAllocation(*owner)
	lease.Close()
	if err != nil {
		t.Fatal(err)
	}
	key := map[string]any{
		"runner_id": uuid.NewString(), "attempt_id": restartAttempt,
		"registration_id": nil, "registration_revision": nil,
		"policy": map[string]any{"revision": "initial", "policy": map[string]any{"mode": "disabled"}},
	}
	retired, err := client.ProtectedBoot(ctx, boxID, sdk.ProtectedBootRetire, key, nil)
	if err != nil {
		t.Fatalf("retire the unconfirmed restart: %v", err)
	}
	var evidence struct {
		Epoch   json.RawMessage `json:"epoch"`
		Outcome string          `json:"outcome"`
	}
	if err := json.Unmarshal(retired, &evidence); err != nil || evidence.Outcome != "retired" {
		t.Fatalf("expected Runtime retirement evidence, got %s (%v)", retired, err)
	}
	removal := map[string]any{"key": key, "epoch": evidence.Epoch, "runner_box_name": boxID}
	if _, err := client.ProtectedBoot(ctx, boxID, sdk.ProtectedBootRemove, removal, nil); err != nil {
		t.Fatalf("remove the exact retired restart from its native allocation: %v", err)
	}
	if _, err := client.runtime.GetInfo(ctx, nativeID); !sdk.IsNotFound(err) {
		t.Fatalf("retirement must remove the native allocation: %v", err)
	}
	nextAttempt := uuid.NewString()
	nextID, err := client.AllocateProtectedPlaceholder(ctx, request, nextAttempt)
	if err != nil {
		t.Fatalf("allocate successor after cleanup: %v", err)
	}
	if _, err := client.ProtectedBoot(ctx, boxID, sdk.ProtectedBootRemove, removal, nil); err != nil {
		t.Fatalf("logical name must replay the exact Runtime receipt: %v", err)
	}
	if got, err := client.AllocateProtectedPlaceholder(ctx, request, nextAttempt); err != nil || got != nextID {
		t.Fatalf("old receipt must preserve the current allocation %q, got %q (%v)", nextID, got, err)
	}
}
