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
	"strings"
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

func TestIntegrationQualifiedCloudOutboundLifecycle(t *testing.T) {
	if os.Getenv("BOXLITE_PLATFORM_GUARD_PROFILE") != "cloud" {
		t.Skip("requires a Linux host guard with qualified inventory v2")
	}
	const target = "cloud-dual-stack"
	ctx := t.Context()
	home := t.TempDir()
	client := completeCreateFixture(t, home)
	defer func() {
		_ = client.Destroy(ctx, target)
		_ = client.Close()
	}()

	assertLive := func(expected sdk.CompleteOutboundSnapshot) {
		t.Helper()
		status, err := client.CompleteOutboundStatus(ctx, target)
		if err != nil || status.Observed == nil || status.ApplicationState != sdk.OutboundConfirmed ||
			!sameCompleteCreateSnapshot(status.Persisted, expected) ||
			!sameCompleteCreateSnapshot(status.Observed.Snapshot, expected) {
			t.Fatalf("expected confirmed plan %+v, got %+v: %v", expected, status, err)
		}
	}
	prepared, err := client.PrepareOutboundCreate(ctx, "cloud-original",
		json.RawMessage(`{"mode":"enabled","allow_net":["2001:db8::2"]}`))
	if err != nil || prepared.Snapshot.Admission != sdk.OutboundAdmissionExtendedDualStack || prepared.Snapshot.IPv6 == nil {
		t.Fatalf("qualified prepare: %+v, %v", prepared, err)
	}
	created, err := client.CreateCompleteOutbound(ctx, target, completeCreateRequest(target, prepared))
	if err != nil || created.Outcome != dto.CompleteCreateInstalled || created.Snapshot == nil ||
		!sameCompleteCreateSnapshot(*created.Snapshot, prepared.Snapshot) {
		t.Fatalf("qualified create: %+v, %v", created, err)
	}
	assertLive(prepared.Snapshot)
	t.Log("qualified create confirmed the prepared plan")

	command := func(input map[string]any, expected string) sdk.HostedOutboundReceipt {
		t.Helper()
		body, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		receipt, err := client.HostedOutbound(ctx, target, body)
		if err != nil || receipt.Outcome != expected {
			t.Fatalf("%s: expected %s, got %+v, %v", input["operation"], expected, receipt, err)
		}
		return receipt
	}
	replacement := command(map[string]any{
		"operation": "prepare", "revision": "cloud-replaced", "previous": prepared.Snapshot,
		"policy": json.RawMessage(`{"mode":"enabled","allow_net":["2001:db8::3"]}`),
	}, "prepared")
	if replacement.Candidate == nil || replacement.Candidate.Snapshot.IPv6 == nil ||
		replacement.Candidate.Snapshot.Admission != sdk.OutboundAdmissionExtendedDualStack ||
		replacement.Candidate.Snapshot.Revision != "cloud-replaced" ||
		*replacement.Candidate.Snapshot.IPv6 != *prepared.Snapshot.IPv6 {
		t.Fatalf("replacement changed the link plan: %+v", replacement)
	}
	attempt := map[string]any{
		"incarnation": target, "attempt_id": "cloud-replace", "generation": 1,
		"previous": prepared.Snapshot, "candidate": replacement.Candidate,
	}
	command(map[string]any{"operation": "apply", "attempt": attempt}, "applied")
	command(map[string]any{"operation": "finalize", "attempt": attempt}, "finalized")
	installed := replacement.Candidate.Snapshot
	assertLive(installed)
	t.Log("qualified replacement kept the plan and confirmed the new revision")

	request := dto.CompleteRebuildRequest{
		Snapshot: installed, Stamp: 1000,
		Box: dto.RecoverBoxDTO{MemoryQuota: 1, StorageQuota: 4, OsUser: "root", ErrorReason: "test recovery"},
	}
	mismatch := request
	altered := *installed.IPv6
	altered.Guest, altered.Gateway = altered.Gateway, altered.Guest
	mismatch.Snapshot.IPv6 = &altered
	if _, err := client.RebuildCompleteOutbound(ctx, target, mismatch); err == nil {
		t.Fatal("rebuild accepted a different IPv6 plan")
	}
	assertLive(installed)

	previous, err := client.nativeBoxInfo(ctx, target)
	if err != nil {
		t.Fatal(err)
	}
	pinned, err := client.checkCompleteRebuild(ctx, target, installed, true)
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(body)
	lease, err := client.lockCheckpointTarget(ctx, target)
	if err != nil {
		t.Fatal(err)
	}
	err = lease.SaveCompleteRebuild(checkpoint.CompleteRebuild{
		Stamp: request.Stamp, Fingerprint: hex.EncodeToString(digest[:]), PreviousID: previous.ID, RebuildPin: pinned.RebuildPin,
	})
	if err == nil {
		err = client.destroy(ctx, target, lease)
	}
	lease.Close()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.nativeBoxInfo(ctx, target); !sdk.IsNotFound(err) {
		t.Fatalf("expected an empty rebuild target: %v", err)
	}

	stateDir := os.Getenv("BOXLITE_PLATFORM_GUARD_STATE_DIR")
	if stateDir == "" {
		stateDir = "/run/boxlite-platform-guard"
	}
	t.Setenv("BOXLITE_PLATFORM_GUARD_STATE_DIR", t.TempDir())
	if _, err := client.RebuildCompleteOutbound(ctx, target, request); err == nil || !strings.Contains(err.Error(), "Cloud platform guard") {
		t.Fatalf("expected missing Cloud guard authority to refuse rebuild: %v", err)
	}
	if _, err := client.nativeBoxInfo(ctx, target); !sdk.IsNotFound(err) {
		t.Fatalf("refused rebuild created a native Box: %v", err)
	}
	t.Setenv("BOXLITE_PLATFORM_GUARD_STATE_DIR", stateDir)
	rebuilt, err := client.RebuildCompleteOutbound(ctx, target, request)
	if err != nil || !sameCompleteCreateSnapshot(rebuilt, installed) {
		t.Fatalf("empty-host rebuild: %+v, %v", rebuilt, err)
	}
	current, err := client.nativeBoxInfo(ctx, target)
	if err != nil || current.ID == previous.ID {
		t.Fatalf("expected a different native Box after rebuild: %+v, %v", current, err)
	}
	if _, err := client.Start(ctx, target, nil, nil); err != nil {
		t.Fatal(err)
	}
	assertLive(installed)
	for _, check := range []struct {
		args []string
		want string
	}{
		{[]string{"-6", "addr", "show", "dev", installed.IPv6.Interface}, installed.IPv6.Guest + "/64"},
		{[]string{"-6", "route", "show", "default"}, "via " + installed.IPv6.Gateway + " dev " + installed.IPv6.Interface},
	} {
		result, err := client.Exec(ctx, target, "ip", check.args...)
		if err != nil || result.ExitCode != 0 || !strings.Contains(result.StdOut, check.want) {
			t.Fatalf("rebuilt Guest ip %v did not show %q: %+v, %v", check.args, check.want, result, err)
		}
	}
	t.Log("qualified empty-host rebuild restored the exact installed plan")
}
