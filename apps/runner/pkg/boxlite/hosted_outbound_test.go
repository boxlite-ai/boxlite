// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/checkpoint"
)

func TestIntegrationHostedOutboundRestoreSurvivesRunnerRestart(t *testing.T) {
	const target = "complete-owned-replace"
	ctx := t.Context()
	home := t.TempDir()
	client := completeCreateFixture(t, home)
	defer func() {
		_ = client.Destroy(ctx, target)
		_ = client.Close()
	}()
	prepared, err := client.PrepareOutboundCreate(ctx, "original",
		json.RawMessage(`{"mode":"enabled","allow_net":["example.test:443"]}`))
	if err != nil {
		t.Fatal(err)
	}
	created, err := client.CreateCompleteOutbound(ctx, target, completeCreateRequest(target, prepared))
	if err != nil || created.Outcome != dto.CompleteCreateInstalled {
		t.Fatalf("create predecessor: %+v, %v", created, err)
	}
	command := func(input map[string]any) (sdk.HostedOutboundReceipt, error) {
		body, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		return client.HostedOutbound(ctx, target, body)
	}
	preparedReplace, err := command(map[string]any{
		"operation": "prepare", "revision": "candidate", "previous": prepared.Snapshot,
		"policy": json.RawMessage(`{"mode":"enabled","deny_net":[]}`),
	})
	if err != nil || preparedReplace.Candidate == nil || !preparedReplace.Candidate.DenyPresent {
		t.Fatalf("prepare replacement: %+v, %v", preparedReplace, err)
	}
	attempt := map[string]any{
		"incarnation": target, "attempt_id": "attempt-a", "generation": 1,
		"previous": prepared.Snapshot, "candidate": preparedReplace.Candidate,
	}
	expectReceipt := func(method, outcome string) sdk.HostedOutboundReceipt {
		t.Helper()
		receipt, err := command(map[string]any{"operation": method, "attempt": attempt})
		if err != nil || receipt.Outcome != outcome {
			t.Fatalf("%s: expected %s, got %+v, %v", method, outcome, receipt, err)
		}
		return receipt
	}
	expectReceipt("cancel", "cancelled")
	expectReceipt("apply", "cancelled")
	attempt["attempt_id"] = "attempt-b"
	attempt["generation"] = 2
	expectReceipt("apply", "applied")
	handle, err := client.getOrFetchBox(ctx, target)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Stop(ctx, target, false); err != nil {
		handle.Close()
		t.Fatal(err)
	}
	handle.Close()
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	client = completeCreateFixture(t, home)
	if _, err := client.Start(ctx, target, nil, nil); err != nil {
		t.Fatal(err)
	}
	expectReceipt("reconcile", "applied")
	restored, err := command(map[string]any{"operation": "restore", "attempt": attempt, "revision": "restored"})
	expected := prepared.Snapshot
	expected.Revision = "restored"
	if err != nil || restored.Outcome != "restored" || restored.Snapshot == nil ||
		!sameCompleteCreateSnapshot(*restored.Snapshot, expected) {
		t.Fatalf("restore predecessor: %+v, %v", restored, err)
	}
	status, err := client.CompleteOutboundStatus(ctx, target)
	if err != nil || status.Observed == nil || status.ApplicationState != sdk.OutboundConfirmed ||
		!sameCompleteCreateSnapshot(status.Persisted, expected) || !sameCompleteCreateSnapshot(status.Observed.Snapshot, expected) {
		t.Fatalf("confirm restored policy: %+v, %v", status, err)
	}
	expectReceipt("finalize", "finalized")
	handle, err = client.getOrFetchBox(ctx, target)
	if err != nil {
		t.Fatal(err)
	}
	err = client.Stop(ctx, target, false)
	handle.Close()
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	client = completeCreateFixture(t, home)
	expectReceipt("apply", "finalized")
	if _, err := command(map[string]any{"operation": "restore", "attempt": attempt, "revision": "different-restore"}); err == nil {
		t.Fatal("a different restore revision recovered the finalized receipt")
	}
	altered := *preparedReplace.Candidate
	altered.DenyPresent = false
	attempt["candidate"] = altered
	if _, err := command(map[string]any{"operation": "reconcile", "attempt": attempt}); err == nil {
		t.Fatal("a different explicit deny intent recovered the finalized receipt")
	}
	attempt["candidate"] = preparedReplace.Candidate
	expectReceipt("reconcile", "finalized")
	attempt["attempt_id"] = "attempt-a"
	attempt["generation"] = 1
	if _, err := command(map[string]any{"operation": "apply", "attempt": attempt}); err == nil {
		t.Fatal("the previous generation was accepted after finalization")
	}
}

func TestIntegrationCompleteRebuildPreservesInstalledRevision(t *testing.T) {
	const target = "complete-rebuild"
	ctx := t.Context()
	client := completeCreateFixture(t, t.TempDir())
	defer client.Close()
	defer client.Destroy(ctx, target)
	prepared, err := client.PrepareOutboundCreate(ctx, "saved-revision",
		json.RawMessage(`{"mode":"enabled","allow_net":["example.test:443"]}`))
	if err != nil {
		t.Fatal(err)
	}
	created, err := client.CreateCompleteOutbound(ctx, target, completeCreateRequest(target, prepared))
	if err != nil || created.Outcome != dto.CompleteCreateInstalled {
		t.Fatalf("create source: %+v, %v", created, err)
	}
	previous, err := client.nativeBoxInfo(ctx, target)
	if err != nil {
		t.Fatal(err)
	}
	request := dto.CompleteRebuildRequest{
		Snapshot: prepared.Snapshot, Stamp: 1000,
		Box: dto.RecoverBoxDTO{MemoryQuota: 1, StorageQuota: 4, OsUser: "root", ErrorReason: "test recovery"},
	}
	mismatch := request
	mismatch.Snapshot.Revision = "wrong-revision"
	if _, err := client.RebuildCompleteOutbound(ctx, target, mismatch); err == nil {
		t.Fatal("a mismatched saved identity was accepted")
	}
	retained, err := client.nativeBoxInfo(ctx, target)
	if err != nil || retained.ID != previous.ID || retained.State != sdk.StateRunning {
		t.Fatalf("refusal did not preserve the source: %+v, %v", retained, err)
	}
	// Exercise the recovery boundary after Runtime verified the installed
	// snapshot and Runner durably recorded the backend, before removal.
	pinned, err := client.checkCompleteRebuild(ctx, target, prepared.Snapshot, true)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(encoded)
	lease, err := client.lockCheckpointTarget(ctx, target)
	if err != nil {
		t.Fatal(err)
	}
	err = lease.SaveCompleteRebuild(checkpoint.CompleteRebuild{
		Stamp: request.Stamp, Fingerprint: hex.EncodeToString(digest[:]), PreviousID: previous.ID,
		RebuildPin: pinned.RebuildPin,
	})
	lease.Close()
	if err != nil {
		t.Fatal(err)
	}
	drifted := t.TempDir()
	shim := `#!/bin/sh
test "$(cat)" = '{"outbound_policy_probe":1}' || exit 1
printf '%s\n' '{"admission":false,"deny":false,"port":false,"capacity":false}'`
	if err := os.WriteFile(filepath.Join(drifted, "boxlite-shim"), []byte(shim), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("BOXLITE_RUNTIME_DIR", drifted+string(os.PathListSeparator)+os.Getenv("BOXLITE_RUNTIME_DIR"))
	var unsupported *sdk.Error
	if _, err := client.PrepareOutboundCreate(ctx, "drift-check", json.RawMessage(`{"mode":"enabled","allow_net":["example.test:443"]}`)); !errors.As(err, &unsupported) || unsupported.Code != sdk.ErrUnsupported {
		t.Fatalf("ordinary admission did not observe the changed backend: %v", err)
	}
	proof, err := client.RebuildCompleteOutbound(ctx, target, request)
	if err != nil || !sameCompleteCreateSnapshot(proof, prepared.Snapshot) {
		t.Fatalf("complete rebuild: %+v, %v", proof, err)
	}
	current, err := client.nativeBoxInfo(ctx, target)
	if err != nil || current.ID == previous.ID {
		t.Fatalf("expected a new native Box: %+v, %v", current, err)
	}
	if _, err := client.Start(ctx, target, nil, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := client.RebuildCompleteOutbound(ctx, target, request); err != nil {
		t.Fatalf("rebuild retry failed: %v", err)
	}
	replayed, err := client.nativeBoxInfo(ctx, target)
	if err != nil || replayed.ID != current.ID {
		t.Fatalf("rebuild retry changed native Box: %+v, %v", replayed, err)
	}
	status, err := client.CompleteOutboundStatus(ctx, target)
	if err != nil || status.Observed == nil || status.ApplicationState != sdk.OutboundConfirmed ||
		!sameCompleteCreateSnapshot(status.Observed.Snapshot, prepared.Snapshot) {
		t.Fatalf("rebuilt live snapshot: %+v, %v", status, err)
	}
}
