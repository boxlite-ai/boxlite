/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

package poller

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	runnerapiclient "github.com/boxlite-ai/runner/pkg/apiclient"
)

func TestPollJobsSendsRunnerEpochOnce(t *testing.T) {
	receivedHeaders := make(chan []string, 8)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		receivedHeaders <- append([]string(nil), request.Header.Values(runnerapiclient.RunnerEpochHeader)...)
		response.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(response, `{"jobs":[]}`)
	}))
	defer server.Close()

	t.Setenv("BOXLITE_API_URL", server.URL)
	t.Setenv("BOXLITE_RUNNER_TOKEN", "test-token")
	t.Setenv("RUNNER_DOMAIN", "127.0.0.1")

	const runnerEpoch = "00000000-0000-4000-8000-000000000001"
	service, err := NewService(&PollerServiceConfig{
		PollTimeout: time.Second,
		PollLimit:   1,
		Logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
		RunnerEpoch: runnerEpoch,
	})
	if err != nil {
		t.Fatal(err)
	}
	service.client.GetConfig().HTTPClient = server.Client()

	requestContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := service.pollJobs(requestContext); err != nil {
		t.Fatal(err)
	}
	var values []string
	select {
	case values = <-receivedHeaders:
	case <-time.After(time.Second):
		t.Fatal("poll request did not reach test server")
	}
	if len(values) != 1 || values[0] != runnerEpoch {
		t.Fatalf("runner epoch header values = %q, want one value %q", values, runnerEpoch)
	}
}
