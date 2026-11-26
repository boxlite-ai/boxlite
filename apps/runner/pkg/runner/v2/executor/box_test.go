// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package executor

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/google/uuid"
	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
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

type createSuccessBackend struct {
	*fakeBackend
}

func (b *createSuccessBackend) Create(context.Context, dto.CreateBoxDTO) (string, string, error) {
	return "box-1", "boxlite", nil
}

func TestCreateBoxJobTracesWaitPreparationAndCompletionReport(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	defer func() {
		otel.SetTracerProvider(previous)
		_ = provider.Shutdown(context.Background())
	}()

	h := newHarness(t, nil)
	h.executor.backend = &createSuccessBackend{fakeBackend: h.backend}
	job := apiclient.NewJob(testJobId, apiclient.JOBTYPE_CREATE_BOX, apiclient.JOBSTATUS_IN_PROGRESS, "BOX", testBoxId, time.Now().Add(-time.Second).Format(time.RFC3339Nano))
	job.SetPayload(`{"id":"box-1","image":"base"}`)

	h.executor.Execute(context.Background(), job)
	assertCompleted(t, h.lastReport(t))

	ended := make(map[string]sdktrace.ReadOnlySpan)
	for _, span := range recorder.Ended() {
		ended[span.Name()] = span
	}
	for _, name := range []string{"job", "job.wait", "job.prepare", "execute_CREATE_BOX", "update_job_status"} {
		if ended[name] == nil {
			t.Errorf("missing %s span; ended spans = %v", name, recorder.Ended())
		}
	}
	if ended["job.wait"] != nil && time.Since(ended["job.wait"].StartTime()) < 500*time.Millisecond {
		t.Errorf("job.wait did not start at the job creation timestamp: %v", ended["job.wait"].StartTime())
	}
	if ended["job"] != nil && ended["job.wait"] != nil && ended["job"].StartTime().After(ended["job.wait"].StartTime()) {
		t.Errorf("job parent starts after job.wait: job=%v wait=%v", ended["job"].StartTime(), ended["job.wait"].StartTime())
	}
	if ended["update_job_status"] != nil && ended["job"] != nil && ended["update_job_status"].Parent().SpanID() != ended["job"].SpanContext().SpanID() {
		t.Error("completion report is not a child of the job span")
	}
}

func TestJobWaitStartedAtRejectsInvalidAndFutureValues(t *testing.T) {
	now := time.Now()
	for _, value := range []string{"not-a-time", now.Add(time.Hour).Format(time.RFC3339Nano)} {
		if _, ok := jobWaitStartedAt(value, now); ok {
			t.Errorf("jobWaitStartedAt(%q) accepted an invalid wait start", value)
		}
	}
	if started, ok := jobWaitStartedAt(now.Add(-time.Second).Format(time.RFC3339Nano), now); !ok || !started.Equal(now.Add(-time.Second)) {
		t.Fatalf("valid job wait start = %v, %v", started, ok)
	}
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
