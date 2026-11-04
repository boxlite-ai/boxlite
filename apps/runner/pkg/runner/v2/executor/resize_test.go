package executor

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/backend"
)

func TestResizeClaimTokenRequestCompatibility(t *testing.T) {
	for _, token := range []string{"", "current-claim"} {
		t.Run("token="+token, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.URL.RequestURI() != "/jobs/job-1/status" {
					t.Errorf("request = %s %s", r.Method, r.URL.RequestURI())
				}
				if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Authorization") != "Bearer test-token" {
					t.Error("request lost JSON content type or bearer authentication")
				}
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				if body["status"] != "IN_PROGRESS" {
					t.Errorf("unexpected status: %v", body)
				}
				value, present := body["claimToken"]
				if token == "" && (present || len(body) != 1) {
					t.Errorf("legacy request changed: %v", body)
				}
				if token != "" && (!present || value != token || len(body) != 2) {
					t.Errorf("explicit token missing or changed: %v", body)
				}
				w.Header().Set("Content-Type", "application/json")
				fmt.Fprint(w, `{"id":"job-1","type":"START_BOX","status":"IN_PROGRESS","resourceType":"box","resourceId":"box-1","createdAt":"2026-01-01T00:00:00Z"}`)
			}))
			defer server.Close()
			config := apiclient.NewConfiguration()
			config.Servers = apiclient.ServerConfigurations{{URL: server.URL}}
			client := apiclient.NewAPIClient(config)
			request := apiclient.NewUpdateJobStatus(apiclient.JOBSTATUS_IN_PROGRESS)
			if token != "" {
				request.SetClaimToken(token)
			}
			ctx := context.WithValue(context.Background(), apiclient.ContextAccessToken, "test-token")
			_, response, err := client.JobsAPI.UpdateJobStatus(ctx, "job-1").UpdateJobStatus(*request).Execute()
			if response != nil {
				response.Body.Close()
			}
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}

type resizeBackend struct {
	backend.BoxBackend
	targets      []dto.ResizeBoxPayload
	failure      error
	queryFailure error
	wait         bool
}

func (b *resizeBackend) ResizeResources(ctx context.Context, _ string, cpus uint8, memory uint32) (*dto.BoxResources, error) {
	if cpus == 0 && memory == 0 && b.queryFailure != nil {
		return nil, b.queryFailure
	}
	if cpus != 0 || memory != 0 {
		b.targets = append(b.targets, dto.ResizeBoxPayload{CPUs: cpus, MemoryMiB: memory})
		if b.wait {
			<-ctx.Done()
			return nil, ctx.Err()
		}
		if b.failure != nil {
			return nil, b.failure
		}
	}
	// Even the initial query reports mapped == target. It says nothing about
	// whether Linux has finished plugging that RAM, so explicit apply is required.
	return &dto.BoxResources{CPUs: 4, MemoryMiB: 2048, MaxCPUs: 16, MaxMemoryMiB: 8192}, nil
}

func resizeJob() *apiclient.Job {
	job := migrateJob(apiclient.JOBTYPE_RESIZE_BOX, `{"version":1,"cpus":4,"memory_mib":2048}`)
	job.SetClaimToken("current-claim")
	return job
}

func TestResizeAlwaysAppliesExplicitTargetAndReportsClaimToken(t *testing.T) {
	h := newHarness(t, nil)
	b := &resizeBackend{BoxBackend: h.backend}
	h.executor.backend = b
	h.executor.Execute(context.Background(), resizeJob())
	if len(b.targets) != 1 || b.targets[0].CPUs != 4 || b.targets[0].MemoryMiB != 2048 {
		t.Fatalf("explicit target was not applied: %+v", b.targets)
	}
	reports := h.reports()
	if len(reports) != 2 {
		t.Fatalf("reports = %d, want lease confirmation and completion", len(reports))
	}
	assertCompleted(t, reports[1])
	for _, report := range reports {
		if report.body.GetClaimToken() != "current-claim" {
			t.Fatal("missing claim token on wire")
		}
	}
	if reports[1].body.GetResultMetadata() != `{"cpus":4,"memory_mib":2048,"max_cpus":16,"max_memory_mib":8192}` {
		t.Fatalf("unexpected result %s", reports[1].body.GetResultMetadata())
	}
}

func TestResizePartialFailureCanBeReplayedAtTheSameTarget(t *testing.T) {
	h := newHarness(t, nil)
	b := &resizeBackend{BoxBackend: h.backend, failure: fmt.Errorf("guest memory still pending")}
	h.executor.backend = b
	h.executor.Execute(context.Background(), resizeJob())
	reports := h.reports()
	assertFailedWith(t, reports[len(reports)-1], "memory still pending")
	b.failure = nil
	job := resizeJob()
	job.SetClaimToken("reclaimed")
	h.executor.Execute(context.Background(), job)
	reports = h.reports()
	assertCompleted(t, reports[len(reports)-1])
	if len(b.targets) != 2 || b.targets[0] != b.targets[1] {
		t.Fatalf("replay changed target: %+v", b.targets)
	}
}

func TestResizeWaitsForStoppedGuestAndReconcilesAfterRestart(t *testing.T) {
	h := newHarness(t, nil)
	b := &resizeBackend{BoxBackend: h.backend, queryFailure: fmt.Errorf("box is stopped")}
	h.executor.backend = b
	h.executor.Execute(context.Background(), resizeJob())
	reports := h.reports()
	assertFailedWith(t, reports[len(reports)-1], "box is stopped")
	if len(b.targets) != 0 {
		t.Fatal("resize tried to apply while Guest was stopped")
	}
	b.queryFailure = nil // the same Guest has restarted independently
	job := resizeJob()
	job.SetClaimToken("after-restart")
	h.executor.Execute(context.Background(), job)
	reports = h.reports()
	assertCompleted(t, reports[len(reports)-1])
	if len(b.targets) != 1 {
		t.Fatal("restarted Guest was not reconciled with the target")
	}
}

func TestResizeCannotTouchRuntimeWithoutLeaseConfirmation(t *testing.T) {
	h := newHarness(t, nil)
	b := &resizeBackend{BoxBackend: h.backend}
	h.executor.backend = b
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(409) }))
	defer server.Close()
	config := apiclient.NewConfiguration()
	config.Servers = apiclient.ServerConfigurations{{URL: server.URL}}
	h.executor.client = apiclient.NewAPIClient(config)
	h.executor.Execute(context.Background(), resizeJob())
	if len(b.targets) != 0 {
		t.Fatal("stale claim mutated VM")
	}
}

func TestResizeLosingHeartbeatCancelsWaitWithoutCompletingJob(t *testing.T) {
	h := newHarness(t, nil)
	b := &resizeBackend{BoxBackend: h.backend, wait: true}
	h.executor.backend = b
	h.executor.heartbeatInterval = 5 * time.Millisecond
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) > 1 {
			w.WriteHeader(409)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"id":"job-1","type":"RESIZE_BOX","status":"IN_PROGRESS","resourceType":"box","resourceId":"box-1","createdAt":"2026-01-01T00:00:00Z"}`)
	}))
	defer server.Close()
	config := apiclient.NewConfiguration()
	config.Servers = apiclient.ServerConfigurations{{URL: server.URL}}
	h.executor.client = apiclient.NewAPIClient(config)
	done := make(chan struct{})
	go func() { defer close(done); h.executor.Execute(context.Background(), resizeJob()) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("lost lease left resize waiter running")
	}
	if calls.Load() != 2 {
		t.Fatalf("reported completion after losing lease: %d calls", calls.Load())
	}
}
