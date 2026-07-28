/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

package executor

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/models/enums"
	"github.com/boxlite-ai/runner/pkg/runner/v2/runtimegeneration"
)

type runtimeFenceBackend struct {
	startCalls int
	stopCalls  int
	startErr   error
}

func (b *runtimeFenceBackend) Ping(context.Context) error {
	return nil
}

func (b *runtimeFenceBackend) Create(context.Context, dto.CreateBoxDTO) (string, string, error) {
	return "", "", nil
}

func (b *runtimeFenceBackend) Start(context.Context, string, *string, map[string]string) (string, error) {
	b.startCalls++
	return "", b.startErr
}

func (b *runtimeFenceBackend) Stop(context.Context, string, bool) error {
	b.stopCalls++
	return nil
}

func (b *runtimeFenceBackend) Destroy(context.Context, string) error {
	return nil
}

func (b *runtimeFenceBackend) RecoverBox(context.Context, string, dto.RecoverBoxDTO) error {
	return nil
}

func (b *runtimeFenceBackend) UpdateNetworkSettings(context.Context, string, dto.UpdateNetworkSettingsDTO) error {
	return nil
}

func (b *runtimeFenceBackend) GetBoxState(context.Context, string) (enums.BoxState, error) {
	return enums.BoxState(""), nil
}

func newRuntimeFenceExecutor(t *testing.T, backend *runtimeFenceBackend) (*Executor, *runtimegeneration.Registry) {
	t.Helper()
	registry, err := runtimegeneration.NewRegistry(filepath.Join(t.TempDir(), "runtime-generations.json"))
	if err != nil {
		t.Fatal(err)
	}
	return &Executor{
		backend:     backend,
		runnerEpoch: "00000000-0000-4000-8000-000000000001",
		generations: registry,
	}, registry
}

func runtimeJob(jobType apiclient.JobType, payload string) *apiclient.Job {
	return &apiclient.Job{
		Type:       jobType,
		ResourceId: "box-1",
		Payload:    &payload,
	}
}

func TestStartValidatesAndPersistsGenerationBeforeBackendSideEffect(t *testing.T) {
	backend := &runtimeFenceBackend{}
	executor, registry := newRuntimeFenceExecutor(t, backend)

	if _, err := executor.startBox(
		context.Background(),
		runtimeJob(apiclient.JOBTYPE_START_BOX, `{"runtimeGeneration":0}`),
	); err == nil {
		t.Fatal("start with generation zero succeeded")
	}
	if backend.startCalls != 0 {
		t.Fatalf("backend start calls = %d, want 0", backend.startCalls)
	}

	backend.startErr = errors.New("request timed out")
	if _, err := executor.startBox(
		context.Background(),
		runtimeJob(apiclient.JOBTYPE_START_BOX, `{"runtimeGeneration":1}`),
	); err == nil {
		t.Fatal("timed out start succeeded")
	}
	if got := registry.Generation("box-1"); got != 1 {
		t.Fatalf("runtime generation after ambiguous start = %d, want 1", got)
	}
}

func TestStopAdvancesFenceAndPreventsLateStartRollback(t *testing.T) {
	backend := &runtimeFenceBackend{}
	executor, registry := newRuntimeFenceExecutor(t, backend)

	if _, err := executor.startBox(
		context.Background(),
		runtimeJob(apiclient.JOBTYPE_START_BOX, `{"runtimeGeneration":1}`),
	); err != nil {
		t.Fatal(err)
	}
	if _, err := executor.stopBox(
		context.Background(),
		runtimeJob(
			apiclient.JOBTYPE_STOP_BOX,
			`{"runtimeGeneration":2,"previousRuntimeGeneration":1,"force":true}`,
		),
	); err != nil {
		t.Fatal(err)
	}
	if got := registry.Generation("box-1"); got != 0 {
		t.Fatalf("runtime generation after stop = %d, want 0", got)
	}
	if got := registry.LastCommandGeneration("box-1"); got != 2 {
		t.Fatalf("command fence after stop = %d, want 2", got)
	}

	if _, err := executor.startBox(
		context.Background(),
		runtimeJob(apiclient.JOBTYPE_START_BOX, `{"runtimeGeneration":1}`),
	); err == nil {
		t.Fatal("late generation-1 start succeeded after generation-2 stop")
	}
	if backend.startCalls != 1 {
		t.Fatalf("backend start calls = %d, want 1", backend.startCalls)
	}
}

func TestOrphanStopRequiresExactActiveGenerationAndIsIdempotent(t *testing.T) {
	backend := &runtimeFenceBackend{}
	executor, registry := newRuntimeFenceExecutor(t, backend)
	if prepared, err := registry.PrepareStart("box-1", 3); err != nil || !prepared {
		t.Fatalf("prepare start = %t, %v", prepared, err)
	}

	if _, err := executor.stopOrphanRuntime(
		context.Background(),
		runtimeJob(apiclient.JOBTYPE_STOP_ORPHAN_RUNTIME, `{"runtimeGeneration":2,"force":true}`),
	); err != nil {
		t.Fatal(err)
	}
	if backend.stopCalls != 0 {
		t.Fatalf("mismatched orphan stop calls = %d, want 0", backend.stopCalls)
	}

	exact := runtimeJob(apiclient.JOBTYPE_STOP_ORPHAN_RUNTIME, `{"runtimeGeneration":3,"force":true}`)
	if _, err := executor.stopOrphanRuntime(context.Background(), exact); err != nil {
		t.Fatal(err)
	}
	if _, err := executor.stopOrphanRuntime(context.Background(), exact); err != nil {
		t.Fatal(err)
	}
	if backend.stopCalls != 1 {
		t.Fatalf("exact orphan stop calls = %d, want 1", backend.stopCalls)
	}
	if got := registry.Generation("box-1"); got != 0 {
		t.Fatalf("runtime generation after orphan cleanup = %d, want 0", got)
	}
}
