// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package executor

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/google/uuid"
)

type startErrorBackend struct {
	*fakeBackend
	err      error
	metadata map[string]string
}

func (b *startErrorBackend) Start(_ context.Context, _ string, _ *string, metadata map[string]string) (string, error) {
	b.metadata = metadata
	return "", b.err
}

func TestStartBoxJobReportsFilestorePreparationFailure(t *testing.T) {
	h := newHarness(t, nil)
	backend := &startErrorBackend{fakeBackend: h.backend, err: errors.New("filestore ml-scratch mount target mismatch")}
	h.executor.backend = backend
	metadata := map[string]string{
		"volumes": `[{"volumeId":"vol-a","mountPath":"/data","filestore":{"instance":"ml-scratch","server":"10.0.0.8","export":"/vol2"}}]`,
	}
	payload, err := json.Marshal(StartBoxPayload{Metadata: metadata})
	if err != nil {
		t.Fatal(err)
	}
	job := apiclient.NewJob(uuid.NewString(), apiclient.JOBTYPE_START_BOX, apiclient.JOBSTATUS_IN_PROGRESS, "BOX", testBoxId, "2026-11-06T00:00:00Z")
	job.SetPayload(string(payload))

	h.executor.Execute(context.Background(), job)

	report := h.lastReport(t)
	if report.body.Status != apiclient.JOBSTATUS_FAILED || !strings.Contains(report.body.GetErrorMessage(), "mount target mismatch") {
		t.Fatalf("START_BOX status = %#v, want failed with the target mismatch", report.body)
	}
	if backend.metadata["volumes"] != metadata["volumes"] {
		t.Fatalf("Start metadata = %v, want %v", backend.metadata, metadata)
	}
}
