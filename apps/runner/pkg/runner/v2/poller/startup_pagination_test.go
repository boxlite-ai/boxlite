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
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/runner/v2/executor"
)

func TestStartupRecoveryListsAllJobs(t *testing.T) {
	for _, failPage := range []int{0, 1, 2} {
		t.Run(fmt.Sprintf("temporary failure on page %d", failPage), func(t *testing.T) {
			const count = 101
			var jobs []apiclient.Job
			for i := range count {
				id := strconv.Itoa(i)
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
					if raw := r.URL.Query().Get("page"); raw != "" {
						page, _ = strconv.Atoi(raw)
					}
					if page < 1 || page > 2 || r.URL.Query().Get("status") != "IN_PROGRESS" {
						t.Errorf("unexpected list query: %s", r.URL.RawQuery)
						w.WriteHeader(http.StatusBadRequest)
						return
					}
					pageCalls[page]++
					if page == failPage && pageCalls[page] == 1 {
						w.WriteHeader(http.StatusServiceUnavailable)
						return
					}
					// Completing page-one jobs before listing page two would
					// shrink the offset-paginated results and hide remaining jobs.
					var remaining []apiclient.Job
					for _, job := range jobs {
						if reports[job.Id] == 0 {
							remaining = append(remaining, job)
						}
					}
					total := len(remaining)
					start := min((page-1)*100, total)
					_ = json.NewEncoder(w).Encode(apiclient.NewPaginatedJobs(remaining[start:min(start+100, total)], float32(total), float32(page), float32((total+99)/100)))
					scanComplete = page == 2
					return
				}
				id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/jobs/"), "/status")
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
			for range count {
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
				if reports[job.Id] != 1 {
					t.Errorf("job %s recovered %d times", job.Id, reports[job.Id])
				}
			}
			if failPage != 0 && pageCalls[failPage] < 2 {
				t.Errorf("page %d did not retry: %v", failPage, pageCalls)
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
