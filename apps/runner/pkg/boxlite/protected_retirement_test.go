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
	"testing"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/cmd/runner/config"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/checkpoint"
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
