/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

package executor

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	runnerapiclient "github.com/boxlite-ai/runner/pkg/apiclient"
	"github.com/boxlite-ai/runner/pkg/runner/v2/runtimegeneration"
)

func TestUpdateJobStatusSendsRunnerEpochOnce(t *testing.T) {
	receivedHeaders := make(chan []string, 8)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		receivedHeaders <- append([]string(nil), request.Header.Values(runnerapiclient.RunnerEpochHeader)...)
		response.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(response, `{
			"id":"00000000-0000-4000-8000-000000000002",
			"type":"CREATE_BOX",
			"status":"COMPLETED",
			"resourceType":"box",
			"resourceId":"box-1",
			"createdAt":"2026-07-23T00:00:00Z"
		}`)
	}))
	defer server.Close()

	t.Setenv("BOXLITE_API_URL", server.URL)
	t.Setenv("BOXLITE_RUNNER_TOKEN", "test-token")
	t.Setenv("RUNNER_DOMAIN", "127.0.0.1")

	registry, err := runtimegeneration.NewRegistry(filepath.Join(t.TempDir(), "runtime-generations.json"))
	if err != nil {
		t.Fatal(err)
	}
	const runnerEpoch = "00000000-0000-4000-8000-000000000001"
	executor, err := NewExecutor(&ExecutorConfig{
		Logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
		RunnerEpoch: runnerEpoch,
		Generations: registry,
	})
	if err != nil {
		t.Fatal(err)
	}
	executor.client.GetConfig().HTTPClient = server.Client()

	requestContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := executor.updateJobStatus(
		requestContext,
		"00000000-0000-4000-8000-000000000002",
		apiclient.JOBSTATUS_COMPLETED,
		nil,
		nil,
	); err != nil {
		t.Fatal(err)
	}
	var values []string
	select {
	case values = <-receivedHeaders:
	case <-time.After(time.Second):
		t.Fatal("status request did not reach test server")
	}
	if len(values) != 1 || values[0] != runnerEpoch {
		t.Fatalf("runner epoch header values = %q, want one value %q", values, runnerEpoch)
	}
}
