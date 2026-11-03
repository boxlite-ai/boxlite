// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package executor

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	blclient "github.com/boxlite-ai/runner/pkg/boxlite"
)

type checkpointBackendFixture struct {
	*fakeBackend
	run func(context.Context, blclient.CheckpointJob) (*blclient.CheckpointResult, error)
}

func (f *checkpointBackendFixture) ExecuteCheckpoint(ctx context.Context, job blclient.CheckpointJob) (*blclient.CheckpointResult, error) {
	return f.run(ctx, job)
}

func TestCheckpointExecutorDispatchesAndReportsNativeMetadata(t *testing.T) {
	for _, kind := range []apiclient.JobType{apiclient.JOBTYPE_PAUSE_BOX, apiclient.JOBTYPE_RESUME_BOX, apiclient.JOBTYPE_CREATE_CHECKPOINT, apiclient.JOBTYPE_IMPORT_CHECKPOINT} {
		t.Run(string(kind), func(t *testing.T) {
			h := newHarness(t, nil)
			calls := 0
			h.executor.backend = &checkpointBackendFixture{fakeBackend: h.backend, run: func(_ context.Context, payload blclient.CheckpointJob) (*blclient.CheckpointResult, error) {
				calls++
				if payload.BoxID != testBoxId || payload.Kind != string(kind) || payload.OperationID != "11111111-1111-4111-8111-111111111111" {
					t.Fatalf("dispatch payload=%+v", payload)
				}
				return &blclient.CheckpointResult{OperationID: payload.OperationID, NativeCompleted: true, State: "paused"}, nil
			}}
			h.executor.Execute(context.Background(), migrateJob(kind, `{"operationId":"11111111-1111-4111-8111-111111111111","boxId":"spoof","kind":"spoof"}`))
			report := h.lastReport(t)
			assertCompleted(t, report)
			var result blclient.CheckpointResult
			if report.body.ResultMetadata == nil {
				t.Fatal("no completion metadata")
			}
			if e := json.Unmarshal([]byte(*report.body.ResultMetadata), &result); e != nil {
				t.Fatal(e)
			}
			if calls != 1 || !result.NativeCompleted || result.State != "paused" || result.OperationID == "" {
				t.Fatalf("result=%+v calls=%d", result, calls)
			}
		})
	}
}

func TestCheckpointExecutorUnsupportedBackendDoesNoWork(t *testing.T) {
	h := newHarness(t, nil)
	h.executor.Execute(context.Background(), migrateJob(apiclient.JOBTYPE_PAUSE_BOX, `{"operationId":"11111111-1111-4111-8111-111111111111"}`))
	report := h.lastReport(t)
	assertFailedWith(t, report, "no checkpoint backend")
	var result blclient.CheckpointResult
	if e := json.Unmarshal([]byte(*report.body.ResultMetadata), &result); e != nil {
		t.Fatal(e)
	}
	if !result.NativeCompleted || result.Error.Code != "unsupported" || len(h.calls.snapshot()) != 0 {
		t.Fatalf("unsupported result=%+v calls=%v", result, h.calls.snapshot())
	}
}

func TestCheckpointExecutorReportsAfterCancelledJobReallyCompletes(t *testing.T) {
	h := newHarness(t, nil)
	entered := make(chan struct{})
	release := make(chan struct{})
	h.executor.backend = &checkpointBackendFixture{fakeBackend: h.backend, run: func(ctx context.Context, payload blclient.CheckpointJob) (*blclient.CheckpointResult, error) {
		close(entered)
		<-release
		return &blclient.CheckpointResult{OperationID: payload.OperationID, NativeCompleted: true, State: "paused", Error: &blclient.CheckpointFailure{Type: "StorageError", Code: "storage_error", Message: "transfer cancelled after native completion"}}, ctx.Err()
	}}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		h.executor.Execute(ctx, migrateJob(apiclient.JOBTYPE_CREATE_CHECKPOINT, `{"operationId":"11111111-1111-4111-8111-111111111111"}`))
	}()
	<-entered
	cancel()
	select {
	case <-done:
		t.Fatal("job reported before native completion")
	default:
	}
	close(release)
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("cancelled job did not report")
	}
	report := h.lastReport(t)
	assertFailedWith(t, report, "context canceled")
	var result blclient.CheckpointResult
	if e := json.Unmarshal([]byte(*report.body.ResultMetadata), &result); e != nil {
		t.Fatal(e)
	}
	if !result.NativeCompleted || result.Error.Code != "storage_error" {
		t.Fatalf("completion envelope=%+v", result)
	}
}

func TestCheckpointExecutorNeverInventsCompletionForUnknownJournal(t *testing.T) {
	h := newHarness(t, nil)
	h.executor.backend = &checkpointBackendFixture{fakeBackend: h.backend, run: func(context.Context, blclient.CheckpointJob) (*blclient.CheckpointResult, error) {
		return nil, &sdk.Error{Code: sdk.ErrStorage, Message: "operation journal unreadable"}
	}}
	h.executor.Execute(context.Background(), migrateJob(apiclient.JOBTYPE_IMPORT_CHECKPOINT, `{"operationId":"11111111-1111-4111-8111-111111111111"}`))
	report := h.lastReport(t)
	var result blclient.CheckpointResult
	if e := json.Unmarshal([]byte(*report.body.ResultMetadata), &result); e != nil {
		t.Fatal(e)
	}
	if result.NativeCompleted || result.Error.Code != "storage_error" {
		t.Fatal(fmt.Sprintf("unknown completion=%+v", result))
	}
}
