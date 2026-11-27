// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package poller

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
)

// Exercise retries through the generated HTTP client. Each expected path also
// checks that a bad read cannot advance the scan or reach normal polling.
func TestStartupRecoveryReadFailures(t *testing.T) {
	job := apiclient.NewJob("worker", apiclient.JOBTYPE_CREATE_BOX, apiclient.JOBSTATUS_IN_PROGRESS, "BOX", "box", "2026-01-01T00:00:00Z")
	page := func(jobs ...apiclient.Job) *apiclient.PaginatedJobs {
		return apiclient.NewPaginatedJobs(jobs, float32(len(jobs)), 1, 1)
	}
	wrong := *job
	wrong.Id = "other"
	type reply struct {
		path   string
		status int
		body   any
	}
	listed := reply{"/jobs", 200, page(*job)}
	poll := reply{"/jobs/poll", 200, map[string]any{"jobs": []any{}}}
	for _, tc := range []struct {
		name    string
		replies []reply
	}{
		{"already stopped", nil},
		{"shutdown during list failure", []reply{{"/jobs", 503, nil}}},
		{"shutdown during job lookup failure", []reply{listed, {"/jobs/worker", 503, nil}}},
		{"invalid pages retry the same cursor", []reply{{"/jobs", 200, nil}, {"/jobs", 200, page(*job, *job)}, {"/jobs", 200, page()}, poll}},
		{"invalid job reads retry and a deleted job is skipped", []reply{listed, {"/jobs/worker", 200, nil}, {"/jobs/worker", 200, wrong}, {"/jobs/worker", 404, nil}, poll}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			var count atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				next := int(count.Add(1))
				if next > len(tc.replies) {
					t.Errorf("unexpected extra request %s", r.URL)
					cancel()
					return
				}
				response := tc.replies[next-1]
				if r.URL.Path != response.path {
					t.Errorf("request %d path = %q, want %q", next, r.URL.Path, response.path)
					cancel()
					return
				}
				if r.URL.Path == "/jobs" && r.URL.Query().Get("afterId") != "00000000-0000-0000-0000-000000000000" {
					t.Errorf("advanced past an invalid page: %s", r.URL)
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(response.status)
				if response.body != nil {
					_ = json.NewEncoder(w).Encode(response.body)
				}
				if next == len(tc.replies) {
					cancel()
				}
			}))
			cfg := apiclient.NewConfiguration()
			cfg.Servers = apiclient.ServerConfigurations{{URL: server.URL}}
			service := &Service{log: slog.New(slog.NewTextHandler(io.Discard, nil)), client: apiclient.NewAPIClient(cfg)}
			if len(tc.replies) == 0 {
				cancel()
			}
			service.Start(ctx)
			server.Close()
			if got := int(count.Load()); got != len(tc.replies) {
				t.Errorf("received %d requests, want %d", got, len(tc.replies))
			}
		})
	}
}
