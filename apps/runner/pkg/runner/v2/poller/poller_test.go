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
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/runner/pkg/backend"
	"github.com/boxlite-ai/runner/pkg/runner/v2/executor"
)

// Exercise the real Poller, generated API client and Executor without sockets
// or VMs. synctest.Wait makes assertions only after the jobs and poll have blocked.
type pollerHarness struct {
	backend.BoxBackend
	recovered     []apiclient.Job
	pending       []apiclient.Job
	statuses      []int
	limits        []int
	release       chan struct{}
	reportRelease chan struct{}
	stopped       chan struct{}
	mu            sync.Mutex
	active        int
	peak          int
	started       int
}

func (h *pollerHarness) Stop(ctx context.Context, _ string, _ bool) error {
	h.mu.Lock()
	h.active++
	h.started++
	h.peak = max(h.peak, h.active)
	h.mu.Unlock()
	select {
	case <-h.release:
	case <-ctx.Done():
	}
	h.mu.Lock()
	h.active--
	h.mu.Unlock()
	return nil
}

func (h *pollerHarness) RoundTrip(req *http.Request) (*http.Response, error) {
	status := http.StatusOK
	var response any
	switch req.URL.Path {
	case "/jobs":
		response = apiclient.NewPaginatedJobs(h.recovered, float32(len(h.recovered)), 1, 1)
	case "/jobs/poll":
		limit, err := strconv.Atoi(req.URL.Query().Get("limit"))
		if err != nil || limit <= 0 {
			return nil, fmt.Errorf("invalid poll limit %q", req.URL.Query().Get("limit"))
		}
		h.limits = append(h.limits, limit)
		jobs := []apiclient.Job{}
		if len(h.statuses) > 0 {
			status, h.statuses = h.statuses[0], h.statuses[1:]
		} else if len(h.pending) > 0 {
			count := min(limit, len(h.pending))
			jobs, h.pending = h.pending[:count], h.pending[count:]
		} else {
			<-req.Context().Done()
			return nil, req.Context().Err()
		}
		response = apiclient.NewPollJobsResponse(jobs)
	default:
		if req.Method != http.MethodPost || !strings.HasSuffix(req.URL.Path, "/status") {
			return nil, fmt.Errorf("unexpected request: %s %s", req.Method, req.URL.Path)
		}
		if h.reportRelease != nil {
			select {
			case <-h.reportRelease:
			case <-req.Context().Done():
				return nil, req.Context().Err()
			}
		}
		response = jobsForTest(1)[0]
	}
	body, err := json.Marshal(response)
	if err != nil {
		return nil, err
	}
	return &http.Response{
		StatusCode: status,
		Header:     http.Header{"Content-Type": {"application/json"}},
		Body:       io.NopCloser(strings.NewReader(string(body))),
		Request:    req,
	}, nil
}

func jobsForTest(count int) []apiclient.Job {
	jobs := make([]apiclient.Job, count)
	for i := range jobs {
		id := fmt.Sprintf("job-%d", i)
		jobs[i] = *apiclient.NewJob(id, apiclient.JOBTYPE_STOP_BOX, apiclient.JOBSTATUS_IN_PROGRESS, "BOX", id, "2026-09-11T00:00:00Z")
	}
	return jobs
}

func (h *pollerHarness) start(t *testing.T, batch, capacity int) context.CancelFunc {
	t.Helper()
	h.release = make(chan struct{})
	h.stopped = make(chan struct{})
	t.Setenv("BOXLITE_API_URL", "http://poller.invalid")
	t.Setenv("BOXLITE_RUNNER_TOKEN", "YOUR_API_KEY")
	t.Setenv("RUNNER_DOMAIN", "localhost")
	previousTransport := http.DefaultTransport
	http.DefaultTransport = h
	t.Cleanup(func() { http.DefaultTransport = previousTransport })
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	exec, err := executor.NewExecutor(&executor.ExecutorConfig{Backend: h, Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	cfg := &PollerServiceConfig{PollTimeout: time.Second, PollLimit: batch, MaxConcurrentJobs: capacity, Logger: logger, Executor: exec}
	svc, err := NewService(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		defer close(h.stopped)
		svc.Start(ctx)
	}()
	return cancel
}

func TestPollerBoundsJobsAcrossPolls(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := &pollerHarness{pending: jobsForTest(5)}
		cancel := h.start(t, 2, 3)
		defer func() { cancel(); <-h.stopped }()
		synctest.Wait()
		if h.peak != 3 || h.started != 3 {
			t.Fatalf("blocked jobs: peak=%d started=%d, want 3 each", h.peak, h.started)
		}
		if !slices.Equal(h.limits, []int{2, 1}) {
			t.Fatalf("poll limits = %v, want [2 1]", h.limits)
		}
		h.release <- struct{}{}
		synctest.Wait()
		if h.peak != 3 || h.started != 4 || !slices.Equal(h.limits, []int{2, 1, 1}) {
			t.Fatalf("after one completion: peak=%d started=%d limits=%v", h.peak, h.started, h.limits)
		}
		cancel()
		synctest.Wait()
		select {
		case <-h.stopped:
		default:
			t.Fatal("full poller did not stop on cancellation")
		}
	})
}

func TestPollerRecoverySharesCapacity(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		jobs := jobsForTest(6)
		h := &pollerHarness{recovered: jobs[:4], pending: jobs[4:]}
		cancel := h.start(t, 10, 2)
		defer func() { cancel(); <-h.stopped }()
		synctest.Wait()
		if h.peak != 2 || h.started != 2 || len(h.limits) != 0 {
			t.Fatalf("recovery: peak=%d started=%d polls=%v, want 2, 2, none", h.peak, h.started, h.limits)
		}
		for want := 3; want <= 5; want++ {
			h.release <- struct{}{}
			synctest.Wait()
			if h.peak != 2 || h.started != want {
				t.Fatalf("after release: peak=%d started=%d, want 2, %d", h.peak, h.started, want)
			}
		}
		if !slices.Equal(h.limits, []int{1}) {
			t.Fatalf("first poll after recovery = %v, want [1]", h.limits)
		}
	})
}

func TestPollerEmptyAndFailedPollsKeepCapacity(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusRequestTimeout, http.StatusInternalServerError} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				h := &pollerHarness{pending: jobsForTest(3), statuses: []int{status}}
				cancel := h.start(t, 10, 2)
				defer func() { cancel(); <-h.stopped }()
				if status == http.StatusInternalServerError {
					time.Sleep(5 * time.Second) // Advance the fake clock through retry backoff.
				}
				synctest.Wait()
				if h.peak != 2 || h.started != 2 || !slices.Equal(h.limits, []int{2, 2}) {
					t.Fatalf("after status %d: peak=%d started=%d limits=%v", status, h.peak, h.started, h.limits)
				}
			})
		})
	}
}

func TestPollerCancellationInterruptsBackoff(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := &pollerHarness{statuses: []int{http.StatusInternalServerError}}
		cancel := h.start(t, 10, 2)
		defer func() { cancel(); <-h.stopped }()
		synctest.Wait()
		cancel()
		synctest.Wait()
		select {
		case <-h.stopped:
		default:
			t.Fatal("poller is still in retry backoff after cancellation")
		}
	})
}

func TestPollerHoldsCapacityUntilStatusReportReturns(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := &pollerHarness{pending: jobsForTest(3), reportRelease: make(chan struct{})}
		cancel := h.start(t, 1, 2)
		defer func() { cancel(); <-h.stopped }()
		synctest.Wait()
		h.release <- struct{}{}
		synctest.Wait()
		if h.started != 2 || !slices.Equal(h.limits, []int{1, 1}) {
			t.Fatalf("while reporting: started=%d limits=%v, want 2, [1 1]", h.started, h.limits)
		}
		h.reportRelease <- struct{}{}
		synctest.Wait()
		if h.started != 3 || h.peak != 2 {
			t.Fatalf("after reporting: started=%d peak=%d, want 3, 2", h.started, h.peak)
		}
	})
}

func TestNewServiceRejectsInvalidLimits(t *testing.T) {
	for _, cfg := range []PollerServiceConfig{
		{PollLimit: 10, MaxConcurrentJobs: 0},
		{PollLimit: 10, MaxConcurrentJobs: -1},
		{PollLimit: 0, MaxConcurrentJobs: 10},
		{PollLimit: 101, MaxConcurrentJobs: 10},
	} {
		if _, err := NewService(&cfg); err == nil {
			t.Errorf("accepted poll limit %d, concurrency %d", cfg.PollLimit, cfg.MaxConcurrentJobs)
		}
	}
}
