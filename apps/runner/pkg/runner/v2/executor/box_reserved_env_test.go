package executor

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/models/enums"
)

type reservedEnvBackend struct {
	createCalls  int
	recoverCalls int
}

func (b *reservedEnvBackend) Create(context.Context, dto.CreateBoxDTO) (string, string, error) {
	b.createCalls++
	return "", "", errors.New("Create should not be called")
}

func (b *reservedEnvBackend) Start(context.Context, string, *string, map[string]string) (string, error) {
	return "", nil
}

func (b *reservedEnvBackend) Stop(context.Context, string, bool) error {
	return nil
}

func (b *reservedEnvBackend) Destroy(context.Context, string) error {
	return nil
}

func (b *reservedEnvBackend) Resize(context.Context, string, dto.ResizeBoxDTO) error {
	return nil
}

func (b *reservedEnvBackend) RecoverBox(context.Context, string, dto.RecoverBoxDTO) error {
	b.recoverCalls++
	return errors.New("RecoverBox should not be called")
}

func (b *reservedEnvBackend) UpdateNetworkSettings(context.Context, string, dto.UpdateNetworkSettingsDTO) error {
	return nil
}

func (b *reservedEnvBackend) GetBoxState(context.Context, string) (enums.BoxState, error) {
	return enums.BoxStateStarted, nil
}

func (b *reservedEnvBackend) Ping(context.Context) error {
	return nil
}

func TestCreateBoxRejectsReservedExecutorEnvBeforeBackend(t *testing.T) {
	payload := mustJSON(t, dto.CreateBoxDTO{
		Id:           "box",
		Image:        "boxlite/base",
		OsUser:       "boxlite",
		CpuQuota:     1,
		MemoryQuota:  1,
		StorageQuota: 1,
		Env: map[string]string{
			"BOXLITE_EXECUTOR": "guest",
		},
	})
	backend := &reservedEnvBackend{}
	executor := &Executor{backend: backend}
	job := apiclient.NewJob("job-create", apiclient.JOBTYPE_CREATE_BOX, apiclient.JOBSTATUS_IN_PROGRESS, "box", "box", "now")
	job.SetPayload(payload)

	_, err := executor.createBox(context.Background(), job)

	if err == nil || !strings.Contains(err.Error(), "BOXLITE_EXECUTOR is reserved") {
		t.Fatalf("expected reserved env error, got %v", err)
	}
	if backend.createCalls != 0 {
		t.Fatalf("backend Create called %d times, want 0", backend.createCalls)
	}
}

func TestRecoverBoxRejectsReservedExecutorEnvBeforeBackend(t *testing.T) {
	payload := mustJSON(t, dto.RecoverBoxDTO{
		OsUser:       "boxlite",
		CpuQuota:     1,
		MemoryQuota:  1,
		StorageQuota: 1,
		ErrorReason:  "boom",
		Env: map[string]string{
			"BOXLITE_EXECUTOR": "guest",
		},
	})
	backend := &reservedEnvBackend{}
	executor := &Executor{backend: backend}
	job := apiclient.NewJob("job-recover", apiclient.JOBTYPE_RECOVER_BOX, apiclient.JOBSTATUS_IN_PROGRESS, "box", "box", "now")
	job.SetPayload(payload)

	_, err := executor.recoverBox(context.Background(), job)

	if err == nil || !strings.Contains(err.Error(), "BOXLITE_EXECUTOR is reserved") {
		t.Fatalf("expected reserved env error, got %v", err)
	}
	if backend.recoverCalls != 0 {
		t.Fatalf("backend RecoverBox called %d times, want 0", backend.recoverCalls)
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	payload, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	return string(payload)
}
