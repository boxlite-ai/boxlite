// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/cmd/runner/config"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/checkpoint"
)

func completeCreateFixture(t *testing.T, home string) *Client {
	t.Helper()
	t.Setenv("BOXLITE_API_URL", "http://127.0.0.1")
	t.Setenv("BOXLITE_RUNNER_TOKEN", "synthetic-complete-create-token")
	t.Setenv("RUNNER_DOMAIN", "localhost")
	t.Setenv("ENVIRONMENT", "development")
	if _, err := config.GetConfig(); err != nil {
		t.Fatal(err)
	}
	ctx := t.Context()
	client, err := NewClient(ctx, ClientConfig{HomeDir: home, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func completeCreateRequest(id string, prepared sdk.PreparedOutboundCreate) dto.CompleteCreateRequest {
	return dto.CompleteCreateRequest{
		Attempt: dto.CompleteCreateAttempt{Incarnation: id, AttemptID: "attempt-1", Generation: 1,
			Prepared: dto.CompleteCreatePolicy{Snapshot: prepared.Snapshot, DenyPresent: &prepared.DenyPresent}},
		Box: dto.CreateBoxDTO{Id: id, Image: "alpine", MemoryQuota: 1},
	}
}

func TestCompleteCreateFenceSurvivesRunnerRestart(t *testing.T) {
	for _, transport := range []string{"v0", "v2"} {
		t.Run(transport, func(t *testing.T) { checkCompleteCreateFence(t, transport) })
	}
}

func checkCompleteCreateFence(t *testing.T, transport string) {
	t.Helper()
	const target = "complete-fenced"
	ctx := t.Context()
	home := t.TempDir()
	client := completeCreateFixture(t, home)
	request := completeCreateRequest(target, sdk.PreparedOutboundCreate{
		DenyPresent: true,
		Snapshot: sdk.CompleteOutboundSnapshot{
			Revision: "rev-a", Admission: sdk.OutboundAdmissionExtendedIPv4,
			Policy: sdk.EffectiveOutboundPolicy{Mode: sdk.NetworkModeEnabled, AllowNet: []string{}, DenyNet: []string{}},
		},
	})
	if transport == "v2" {
		request.Attempt.JobID = "job-1"
		request.Attempt.ClaimID = "claim-1"
	}
	wrongTarget := request
	wrongTarget.Attempt.Incarnation = "different-box"
	var mismatch *sdk.Error
	if _, err := client.CreateCompleteOutbound(ctx, target, wrongTarget); !errors.As(err, &mismatch) || mismatch.Code != sdk.ErrInvalidArgument {
		t.Fatalf("create accepted a mismatched incarnation: %v", err)
	}
	if _, err := client.CancelCompleteOutboundCreate(ctx, target, wrongTarget.Attempt); !errors.As(err, &mismatch) || mismatch.Code != sdk.ErrInvalidArgument {
		t.Fatalf("cancel accepted a mismatched incarnation: %v", err)
	}
	receipt, err := client.CancelCompleteOutboundCreate(ctx, target, request.Attempt)
	if err != nil || receipt.Outcome != dto.CompleteCreateNoEffect {
		t.Fatalf("cancel before dispatch: receipt=%+v err=%v", receipt, err)
	}
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	restarted := completeCreateFixture(t, home)
	defer restarted.Close()
	replay, err := restarted.CreateCompleteOutbound(ctx, target, request)
	if err != nil || replay.Outcome != dto.CompleteCreateNoEffect {
		t.Fatalf("delayed create after reopen: receipt=%+v err=%v", replay, err)
	}
	replayedReceipt, err := restarted.CancelCompleteOutboundCreate(ctx, target, request.Attempt)
	if err != nil || replayedReceipt.Outcome != dto.CompleteCreateNoEffect {
		t.Fatalf("cancel after reopen: receipt=%+v err=%v", replayedReceipt, err)
	}
	if _, err := restarted.runtime.GetInfo(ctx, target); !sdk.IsNotFound(err) {
		t.Fatalf("delayed create changed the target: %v", err)
	}
	changed := request.Attempt
	if transport == "v2" {
		changed.ClaimID = "claim-2"
		if _, err := restarted.CancelCompleteOutboundCreate(ctx, target, changed); !errors.Is(err, checkpoint.ErrCompleteCreateConflict) {
			t.Fatalf("different claim could use the old generation: %v", err)
		}
		changed = request.Attempt
	}
	denyOmitted := false
	changed.Prepared.DenyPresent = &denyOmitted
	if _, err := restarted.CancelCompleteOutboundCreate(ctx, target, changed); !errors.Is(err, checkpoint.ErrCompleteCreateConflict) {
		t.Fatalf("different intent could use the old generation: %v", err)
	}
	enabled := true
	request.Box.OutboundEnabled = &enabled
	if _, _, err := restarted.Create(ctx, request.Box); !errors.Is(err, checkpoint.ErrCompleteCreateConflict) {
		t.Fatalf("legacy create could use a fenced target: %v", err)
	}
	recover := dto.RecoverBoxDTO{FromVolumeId: "test", MemoryQuota: 1, OutboundEnabled: &enabled}
	if err := restarted.RecoverBox(ctx, target, recover); !errors.Is(err, checkpoint.ErrCompleteCreateConflict) {
		t.Fatalf("legacy recovery could use a fenced target: %v", err)
	}
	changed.Prepared.DenyPresent = nil
	if _, err := restarted.CancelCompleteOutboundCreate(ctx, target, changed); !sdk.IsInvalidArgument(err) {
		t.Fatalf("missing deny presence should be invalid: %v", err)
	}
}

func TestCompleteCreateCapabilityRefusalPrecedesVolumeAndBoxEffects(t *testing.T) {
	const target = "complete-unsupported"
	ctx := t.Context()
	directory := t.TempDir()
	t.Setenv("BOXLITE_RUNTIME_DIR", directory)
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	shimPath := filepath.Join(directory, "boxlite-shim")
	shim := `#!/bin/sh
test "$(cat)" = '{"outbound_policy_probe":1}' || exit 1
printf '%s\n' '{"admission":true,"deny":true,"port":true,"capacity":true}'`
	if err := os.WriteFile(shimPath, []byte(shim), 0700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(directory, "mount-attempted")
	t.Setenv("COMPLETE_CREATE_MOUNT_MARKER", marker)
	mountProbe := `#!/bin/sh
: > "$COMPLETE_CREATE_MOUNT_MARKER"
exit 1`
	if err := os.WriteFile(filepath.Join(directory, "mountpoint"), []byte(mountProbe), 0700); err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	client := completeCreateFixture(t, home)
	defer client.Close()
	prepared, err := client.PrepareOutboundCreate(ctx, "rev-a", json.RawMessage(`{"mode":"enabled","deny_net":[]}`))
	if err != nil || !prepared.DenyPresent {
		t.Fatalf("prepare with deny enabled: prepared=%+v err=%v", prepared, err)
	}
	if err := os.WriteFile(shimPath, []byte(strings.Replace(shim, `"deny":true`, `"deny":false`, 1)), 0700); err != nil {
		t.Fatal(err)
	}
	request := completeCreateRequest(target, prepared)
	request.Box.Volumes = []dto.VolumeDTO{{VolumeId: "test-no-mount", MountPath: "/data"}}
	_, err = client.CreateCompleteOutbound(ctx, target, request)
	var sdkErr *sdk.Error
	if !errors.As(err, &sdkErr) || sdkErr.Code != sdk.ErrUnsupported {
		t.Fatalf("create after capability loss: err=%v, want unsupported", err)
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("create tried to mount a volume: %v", err)
	}
	if _, err := client.runtime.GetInfo(ctx, target); !sdk.IsNotFound(err) {
		t.Fatalf("unsupported create changed the target: %v", err)
	}
	receipt, err := client.CancelCompleteOutboundCreate(ctx, target, request.Attempt)
	if err != nil || receipt.Outcome != dto.CompleteCreateNoEffect || receipt.Failure != "unsupported" {
		t.Fatalf("recover definitive refusal: receipt=%+v err=%v", receipt, err)
	}

	const ambiguous = "complete-unacknowledged"
	shimWithoutReply := "#!/bin/sh\ncat >/dev/null\nprintf '%s' '{}'"
	if err := os.WriteFile(shimPath, []byte(shimWithoutReply), 0700); err != nil {
		t.Fatal(err)
	}
	_, err = client.PrepareOutboundCreate(ctx, "rev-b", json.RawMessage(`{"mode":"enabled","deny_net":[]}`))
	if !errors.As(err, &sdkErr) || sdkErr.Code == sdk.ErrUnsupported {
		t.Fatalf("unacknowledged preparation must remain uncertain: %v", err)
	}
	request = completeCreateRequest(ambiguous, prepared)
	_, err = client.CreateCompleteOutbound(ctx, ambiguous, request)
	if !errors.As(err, &sdkErr) || sdkErr.Code == sdk.ErrUnsupported {
		t.Fatalf("unacknowledged creation must remain uncertain: %v", err)
	}
	receipt, err = client.CancelCompleteOutboundCreate(ctx, ambiguous, request.Attempt)
	if err != nil || receipt.Outcome != dto.CompleteCreatePending || receipt.Failure != "" {
		t.Fatalf("unacknowledged creation cannot claim a definitive refusal: receipt=%+v err=%v", receipt, err)
	}
}

func TestCompleteCreateDoesNotCancelAmbiguousProvisioning(t *testing.T) {
	const target = "complete-ambiguous"
	ctx := t.Context()
	client := completeCreateFixture(t, t.TempDir())
	defer client.Close()
	attempt := completeCreateRequest(target, sdk.PreparedOutboundCreate{Snapshot: sdk.CompleteOutboundSnapshot{
		Revision: "rev-a", Admission: sdk.OutboundAdmissionExtendedIPv4,
		Policy: sdk.EffectiveOutboundPolicy{Mode: sdk.NetworkModeEnabled, AllowNet: []string{}, DenyNet: []string{}},
	}}).Attempt
	owner, err := completeCreateOwner(target, attempt)
	if err != nil {
		t.Fatal(err)
	}
	lease, err := client.checkpointOperations().Lock(ctx, target)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Close()
	if err := lease.ReserveCompleteCreate(owner); err != nil {
		t.Fatal(err)
	}
	if err := lease.BeginCompleteProvisioning(owner); err != nil {
		t.Fatal(err)
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	receipt, err := client.CancelCompleteOutboundCreate(ctx, target, attempt)
	if err != nil || receipt.Outcome != dto.CompleteCreatePending {
		t.Fatalf("cancel after unknown native effect: receipt=%+v err=%v", receipt, err)
	}
	attempt.Generation++
	if _, err := client.CancelCompleteOutboundCreate(ctx, target, attempt); !errors.Is(err, checkpoint.ErrCompleteCreateConflict) {
		t.Fatalf("new attempt could displace ambiguous provisioning: %v", err)
	}
}

func TestIntegrationCompleteCreateReturnsExactLiveProof(t *testing.T) {
	const target = "complete-live-proof"
	ctx := t.Context()
	client := completeCreateFixture(t, t.TempDir())
	defer client.Close()
	defer client.Destroy(ctx, target)

	prepared, err := client.PrepareOutboundCreate(ctx, "rev-a",
		json.RawMessage(`{"mode":"enabled","deny_net":["example.test:443"]}`))
	if err != nil {
		t.Fatal(err)
	}
	request := completeCreateRequest(target, prepared)
	request.Attempt.JobID = "job-live-proof"
	request.Attempt.ClaimID = "claim-live-proof"
	result, err := client.CreateCompleteOutbound(ctx, target, request)
	if err != nil || result.Outcome != dto.CompleteCreateInstalled || result.Snapshot == nil ||
		result.Attempt.JobID != request.Attempt.JobID || result.Attempt.ClaimID != request.Attempt.ClaimID ||
		!sameCompleteCreateSnapshot(prepared.Snapshot, *result.Snapshot) {
		status, statusErr := client.CompleteOutboundStatus(ctx, target)
		witness, _ := json.Marshal(status)
		t.Fatalf("running Box must return exact installation proof: result=%+v err=%v status=%s statusErr=%v",
			result, err, witness, statusErr)
	}
	readback, err := client.CancelCompleteOutboundCreate(ctx, target, request.Attempt)
	if err != nil || readback.Outcome != dto.CompleteCreateInstalled || readback.Snapshot == nil ||
		!sameCompleteCreateSnapshot(*result.Snapshot, *readback.Snapshot) {
		t.Fatalf("cancel after a successful create must preserve installation: result=%+v err=%v", readback, err)
	}
}
