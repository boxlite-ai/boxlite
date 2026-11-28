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
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	api "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/runner/cmd/runner/config"
	"github.com/boxlite-ai/runner/pkg/backend"
	"github.com/boxlite-ai/runner/pkg/runner/v2/executor"
)

type startRecorder struct {
	backend.BoxBackend
	owner string
	calls chan<- string
}

func (b startRecorder) Start(_ context.Context, _ string, _ *string, _ map[string]string) (string, error) {
	b.calls <- b.owner
	return b.owner, nil
}

func TestPollDrainHandsClaimToReplacement(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	intake, stopIntake := context.WithCancel(ctx)
	defer stopIntake()

	job := api.NewJob("job-1", api.JOBTYPE_START_BOX, api.JOBSTATUS_IN_PROGRESS, "BOX", "box-1", "2026-01-01T00:00:00Z")
	job.SetPayload("{}")
	waiting, release := make(chan struct{}), make(chan struct{})
	extraPoll := make(chan struct{}, 1)
	starts, reports := make(chan string, 2), make(chan api.JobStatus, 2)
	var claimed atomic.Bool
	mux := http.NewServeMux()
	mux.HandleFunc("GET /jobs", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("status") != "IN_PROGRESS" {
			t.Errorf("recovery status filter = %q", r.URL.Query().Get("status"))
		}
		jobs := []api.Job{}
		if claimed.Load() {
			jobs = append(jobs, *job)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(api.NewPaginatedJobs(jobs, float32(len(jobs)), 1, 1))
	})
	mux.HandleFunc("GET /jobs/poll", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Test-Runner") == "retiring" {
			if !claimed.Load() {
				close(waiting)
				select {
				case <-release:
					claimed.Store(true)
					w.Header().Set("Content-Type", "application/json")
					_ = json.NewEncoder(w).Encode(api.NewPollJobsResponse([]api.Job{*job}))
				case <-r.Context().Done():
				}
				return
			}
			extraPoll <- struct{}{}
		}
		<-r.Context().Done()
	})
	mux.HandleFunc("POST /jobs/job-1/status", func(w http.ResponseWriter, r *http.Request) {
		var update api.UpdateJobStatus
		if err := json.NewDecoder(r.Body).Decode(&update); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		finished := *job
		finished.SetStatus(update.Status)
		_ = json.NewEncoder(w).Encode(&finished)
		reports <- update.Status
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	t.Setenv("BOXLITE_API_URL", server.URL)
	t.Setenv("BOXLITE_RUNNER_TOKEN", "test-runner")
	t.Setenv("RUNNER_DOMAIN", "localhost")
	cfg, err := config.GetConfig()
	if err != nil {
		t.Fatal(err)
	}
	// GetConfig caches its result across repeated runs in the same test binary.
	previousURL := cfg.BoxliteApiUrl
	cfg.BoxliteApiUrl = server.URL
	t.Cleanup(func() { cfg.BoxliteApiUrl = previousURL })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	start := func(owner string, intake context.Context) <-chan struct{} {
		t.Helper()
		exec, err := executor.NewExecutor(&executor.ExecutorConfig{Logger: log, Backend: startRecorder{owner: owner, calls: starts}})
		if err != nil {
			t.Fatal(err)
		}
		service, err := NewService(&PollerServiceConfig{Logger: log, Executor: exec, PollTimeout: 30 * time.Second, PollLimit: 10})
		if err != nil {
			t.Fatal(err)
		}
		service.client.GetConfig().AddDefaultHeader("Test-Runner", owner)
		done := make(chan struct{})
		go func() {
			defer close(done)
			service.Start(ctx, intake)
		}()
		return done
	}

	retired := start("retiring", intake)
	select {
	case <-waiting:
	case <-ctx.Done():
		t.Fatal("retiring poll never reached the API")
	}
	stopIntake()
	close(release)
	select {
	case owner := <-starts:
		t.Fatalf("%s runner executed the final claim during shutdown", owner)
	case <-extraPoll:
		t.Fatal("retiring runner opened another poll after the final claim")
	case <-retired:
	case <-ctx.Done():
		t.Fatal("retiring poller failed to drain")
	}

	start("replacement", ctx)
	select {
	case owner := <-starts:
		if owner != "replacement" {
			t.Fatalf("executing runner = %s, want replacement", owner)
		}
	case <-ctx.Done():
		t.Fatal("replacement did not execute the committed start")
	}
	select {
	case status := <-reports:
		if status != api.JOBSTATUS_COMPLETED {
			t.Fatalf("job status = %s, want COMPLETED", status)
		}
	case <-ctx.Done():
		t.Fatal("replacement did not report the job outcome")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func TestPollDrainStopPaths(t *testing.T) {
	for _, phase := range []string{"before startup", "startup scan", "empty final poll", "error backoff"} {
		t.Run(phase, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				intake, stopIntake := context.WithCancel(ctx)
				defer stopIntake()
				if phase == "before startup" {
					stopIntake()
				}

				var scans, polls int
				release := make(chan struct{})
				cfg := api.NewConfiguration()
				cfg.Servers[0].URL = "http://runner.test"
				cfg.HTTPClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
					code, body := http.StatusOK, `{"items":[],"total":0,"page":1,"totalPages":1}`
					switch req.URL.Path {
					case "/jobs":
						scans++
						if phase == "startup scan" {
							<-req.Context().Done()
							return nil, req.Context().Err()
						}
					case "/jobs/poll":
						polls++
						if polls > 1 {
							<-req.Context().Done()
							return nil, req.Context().Err()
						}
						if phase == "error backoff" {
							code, body = http.StatusServiceUnavailable, "{}"
						} else {
							select {
							case <-req.Context().Done():
								return nil, req.Context().Err()
							case <-release:
							}
							body = `{"jobs":[]}`
						}
					default:
						t.Errorf("unexpected request %s", req.URL.Path)
					}
					return &http.Response{StatusCode: code, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}, nil
				})}
				service := &Service{log: slog.New(slog.NewTextHandler(io.Discard, nil)), client: api.NewAPIClient(cfg)}
				done := make(chan struct{})
				go func() {
					defer close(done)
					service.Start(ctx, intake)
				}()
				defer func() { cancel(); <-done }()
				synctest.Wait()
				stopIntake()
				synctest.Wait()
				if phase == "empty final poll" {
					select {
					case <-done:
						t.Fatal("runner exited before the final response")
					default:
					}
					close(release)
				}
				synctest.Wait()
				select {
				case <-done:
				default:
					t.Fatalf("poller still active during %s", phase)
				}
				wantScans, wantPolls := 1, 0
				if phase == "before startup" {
					wantScans = 0
				}
				if phase == "empty final poll" || phase == "error backoff" {
					wantPolls = 1
				}
				if scans != wantScans || polls != wantPolls {
					t.Fatalf("observed %d scans and %d polls, want %d scans and %d polls", scans, polls, wantScans, wantPolls)
				}
			})
		})
	}
}
