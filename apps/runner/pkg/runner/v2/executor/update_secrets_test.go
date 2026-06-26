// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package executor

import (
	"context"
	"errors"
	"log/slog"
	"testing"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/models/enums"
)

type recordingBackend struct {
	updateSecretsBoxID   string
	updateSecretsPayload []dto.SecretDTO
}

func (b *recordingBackend) Create(context.Context, dto.CreateBoxDTO) (string, string, error) {
	return "", "", errors.New("not implemented")
}

func (b *recordingBackend) Start(context.Context, string, *string, map[string]string) (string, error) {
	return "", errors.New("not implemented")
}

func (b *recordingBackend) Stop(context.Context, string, bool) error {
	return errors.New("not implemented")
}

func (b *recordingBackend) Destroy(context.Context, string) error {
	return errors.New("not implemented")
}

func (b *recordingBackend) Resize(context.Context, string, dto.ResizeBoxDTO) error {
	return errors.New("not implemented")
}

func (b *recordingBackend) RecoverBox(context.Context, string, dto.RecoverBoxDTO) error {
	return errors.New("not implemented")
}

func (b *recordingBackend) UpdateNetworkSettings(context.Context, string, dto.UpdateNetworkSettingsDTO) error {
	return errors.New("not implemented")
}

func (b *recordingBackend) UpdateSecrets(_ context.Context, boxId string, secrets []dto.SecretDTO) error {
	b.updateSecretsBoxID = boxId
	b.updateSecretsPayload = secrets
	return nil
}

func (b *recordingBackend) GetBoxState(context.Context, string) (enums.BoxState, error) {
	return "", errors.New("not implemented")
}

func (b *recordingBackend) Ping(context.Context) error {
	return errors.New("not implemented")
}

func TestExecuteJobDispatchesUpdateBoxSecrets(t *testing.T) {
	backend := &recordingBackend{}
	executor := &Executor{
		log:     slog.Default(),
		backend: backend,
	}
	payload := `{"secrets":[{"name":"openai","value":"sk-test","hosts":["api.openai.com"],"placeholder":"<BOXLITE_SECRET:openai>"}]}`
	job := apiclient.NewJob(
		"job-1",
		apiclient.JOBTYPE_UPDATE_BOX_SECRETS,
		apiclient.JOBSTATUS_PENDING,
		"BOX",
		"box-1",
		"2026-06-23T00:00:00Z",
	)
	job.SetPayload(payload)

	result, err := executor.executeJob(context.Background(), job)
	if err != nil {
		t.Fatalf("executeJob returned error: %v", err)
	}
	if result != nil {
		t.Fatalf("result = %#v, want nil", result)
	}
	if backend.updateSecretsBoxID != "box-1" {
		t.Fatalf("box ID = %q, want box-1", backend.updateSecretsBoxID)
	}
	if len(backend.updateSecretsPayload) != 1 {
		t.Fatalf("secrets = %d, want 1", len(backend.updateSecretsPayload))
	}
	secret := backend.updateSecretsPayload[0]
	if secret.Name != "openai" || secret.Value != "sk-test" || secret.Placeholder != "<BOXLITE_SECRET:openai>" {
		t.Fatalf("unexpected secret payload: %#v", secret)
	}
	if len(secret.Hosts) != 1 || secret.Hosts[0] != "api.openai.com" {
		t.Fatalf("hosts = %#v, want [api.openai.com]", secret.Hosts)
	}
}
