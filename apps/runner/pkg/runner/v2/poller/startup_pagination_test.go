// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package poller

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"

	"strings"
	"sync"
	"testing"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/runner/v2/executor"
)

func TestStartupRecoveryListsAllJobs(t *testing.T) {
	for _, tc := range []struct {
		name                 string
		failPage             int
		expireAfterFirstPage bool
	}{
		{name: "all active"},
		{name: "first page unavailable", failPage: 1},
		{name: "second page unavailable", failPage: 2},
		{name: "first job expires after first page", expireAfterFirstPage: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			const count = 101
			var jobs []apiclient.Job
			for i := range count {
				id := fmt.Sprintf("00000000-0000-4000-8000-%012d", i)
				job := apiclient.NewJob(id, apiclient.JOBTYPE_CREATE_BOX, apiclient.JOBSTATUS_IN_PROGRESS, "BOX", id, "2026-01-01T00:00:00Z")
				job.SetPayload(fmt.Sprintf(`{"id":%q}`, id))
				jobs = append(jobs, *job)
			}
			var mu sync.Mutex
			pageCalls, reports := map[int]int{}, map[string]int{}
			scanComplete := false
			reported := make(chan string, 2*count)
			polled := make(chan struct{}, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/jobs/poll" {
					select {
					case polled <- struct{}{}:
					default:
					}
					<-r.Context().Done()
					return
				}
				mu.Lock()
				defer mu.Unlock()
				if r.URL.Path == "/jobs" {
					page := 1
					after := r.URL.Query().Get("afterId")
					switch after {
					case "00000000-0000-0000-0000-000000000000":
					case jobs[99].Id:
						page = 2
					default:
						t.Errorf("unexpected cursor %q", after)
					}
					if r.URL.Query().Get("status") != "IN_PROGRESS" {
						t.Error("startup scan omitted status filter")
					}
					pageCalls[page]++
					if page == tc.failPage && pageCalls[page] == 1 {
						w.WriteHeader(http.StatusServiceUnavailable)
						return
					}
					// Completing page-one jobs before listing page two would
					// shrink the offset-paginated results and hide remaining jobs.
					var remaining []apiclient.Job
					for _, job := range jobs {
						if job.Id > after && reports[job.Id] == 0 && !(tc.expireAfterFirstPage && page == 2 && job.Id == jobs[0].Id) {
							remaining = append(remaining, job)
						}
					}
					total := len(remaining)
					_ = json.NewEncoder(w).Encode(apiclient.NewPaginatedJobs(remaining[:min(100, total)], float32(total), 1, float32((total+99)/100)))
					scanComplete = page == 2
					return
				}
				id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/jobs/"), "/status")
				if r.Method == http.MethodGet {
					for _, job := range jobs {
						if job.Id == id {
							if tc.expireAfterFirstPage && id == jobs[0].Id {
								job.Status = apiclient.JOBSTATUS_FAILED
							}
							_ = json.NewEncoder(w).Encode(job)
							return
						}
					}
					http.NotFound(w, r)
					return
				}
				var status apiclient.UpdateJobStatus
				if !strings.HasSuffix(r.URL.Path, "/status") || json.NewDecoder(r.Body).Decode(&status) != nil || status.Status != apiclient.JOBSTATUS_COMPLETED {
					t.Errorf("unexpected status update for %s", id)
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				reports[id]++
				reported <- id
				_ = json.NewEncoder(w).Encode(apiclient.NewJob(id, apiclient.JOBTYPE_CREATE_BOX, status.Status, "BOX", id, "2026-01-01T00:00:00Z"))
			}))
			defer server.Close()
			useTestRunnerAPI(t, server.URL)

			b := &paginationBackend{beforeCreate: func(box dto.CreateBoxDTO) {
				mu.Lock()
				defer mu.Unlock()
				if !scanComplete {
					t.Errorf("job %s dispatched before the final page", box.Id)
				}
			}}
			logger := slog.New(slog.NewTextHandler(io.Discard, nil))
			e, err := executor.NewExecutor(&executor.ExecutorConfig{Backend: b, Logger: logger})
			if err != nil {
				t.Fatal(err)
			}
			service, err := NewService(&PollerServiceConfig{Executor: e, Logger: logger, PollTimeout: time.Second, PollLimit: 100})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
			stopped := make(chan struct{})
			go func() {
				defer close(stopped)
				service.Start(ctx)
			}()
			defer func() { cancel(); <-stopped }()

			seen := make(map[string]bool, count)
			expected := count
			if tc.expireAfterFirstPage {
				expected--
			}
			for range expected {
				select {
				case id := <-reported:
					if seen[id] {
						t.Fatalf("duplicate recovery for job %s", id)
					}
					seen[id] = true
				case <-ctx.Done():
					t.Fatalf("recovered %d of %d jobs", len(seen), count)
				}
			}
			select {
			case <-polled:
			case <-ctx.Done():
				t.Fatal("normal polling did not begin after recovery")
			}
			mu.Lock()
			defer mu.Unlock()
			for _, job := range jobs {
				want := 1
				if tc.expireAfterFirstPage && job.Id == jobs[0].Id {
					want = 0
				}
				if reports[job.Id] != want {
					t.Errorf("job %s recovered %d times, want %d", job.Id, reports[job.Id], want)
				}
			}
			if tc.failPage > 0 && pageCalls[tc.failPage] < 2 {
				t.Errorf("page %d did not retry: %v", tc.failPage, pageCalls)
			}
		})
	}
}

type paginationBackend struct {
	recoveryBackend
	beforeCreate func(dto.CreateBoxDTO)
}

func (b *paginationBackend) Create(_ context.Context, box dto.CreateBoxDTO) (string, string, error) {
	b.beforeCreate(box)
	return box.Id, "test", nil
}

// Capture requests from the generated client used by the runner, including
// callers that still use numbered pages without a recovery cursor.
func TestStartupRecoveryCursorRequests(t *testing.T) {
	const id = "00000000-0000-4000-8000-000000000099"
	for _, cursor := range []string{"", id} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			want := "limit=100&page=1&status=IN_PROGRESS"
			if cursor != "" {
				want = "afterId=" + cursor + "&" + want
			}
			if r.Method != http.MethodGet || r.URL.Path != "/jobs" || r.URL.RawQuery != want {
				t.Errorf("unexpected request: %s %s", r.Method, r.URL)
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(apiclient.NewPaginatedJobs([]apiclient.Job{}, 0, 1, 0))
		}))
		config := apiclient.NewConfiguration()
		config.Servers = apiclient.ServerConfigurations{{URL: server.URL}}
		req := apiclient.NewAPIClient(config).JobsAPI.ListJobs(t.Context()).Status(apiclient.JOBSTATUS_IN_PROGRESS)
		if cursor != "" {
			req = req.AfterId(cursor)
		}
		_, _, err := req.Execute()
		server.Close()
		if err != nil {
			t.Fatal(err)
		}
	}
}
