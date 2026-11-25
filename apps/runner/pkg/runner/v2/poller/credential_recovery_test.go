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
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/runner/cmd/runner/config"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/backend"
	"github.com/boxlite-ai/runner/pkg/runner/v2/executor"
)

type recoveryBackend struct {
	backend.BoxBackend
	creates chan dto.CreateBoxDTO
}

func (b *recoveryBackend) BoxExists(_ context.Context, id string) (bool, error) {
	return id == "existing", nil
}

func (b *recoveryBackend) Create(_ context.Context, box dto.CreateBoxDTO) (string, string, error) {
	b.creates <- box
	return box.Id, "test", nil
}

func TestCredentialStartupRecovery(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	newJob := func(id string, credential bool) apiclient.Job {
		secret := map[string]string{"name": "A"}
		payload := map[string]any{"id": id, "secrets": []any{secret}}
		if credential {
			payload["secretCredential"] = map[string]string{"token": "test-credential"}
		} else {
			secret["value"] = "inline"
		}
		raw, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		job := apiclient.NewJob(id, apiclient.JOBTYPE_CREATE_BOX, apiclient.JOBSTATUS_IN_PROGRESS, "BOX", id, time.Now().Format(time.RFC3339))
		job.SetPayload(string(raw))
		return *job
	}
	missing, existing, inline, fresh := newJob("missing", true), newJob("existing", true), newJob("inline", false), newJob("fresh", true)
	type report struct {
		id string
		apiclient.UpdateJobStatus
	}
	reports := make(chan report, 4)
	var polled, identities, fetches atomic.Int32
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/jobs":
			if got := r.URL.Query().Get("status"); got != "IN_PROGRESS" {
				t.Errorf("startup list status = %q", got)
			}
			_ = json.NewEncoder(w).Encode(apiclient.NewPaginatedJobs([]apiclient.Job{existing, inline, missing}, 3, 1, 1))
		case "/jobs/poll":
			if polled.Add(1) == 1 {
				_ = json.NewEncoder(w).Encode(map[string]any{"jobs": []apiclient.Job{fresh}})
				return
			}
			<-r.Context().Done()
		case "/jobs/missing", "/jobs/existing", "/jobs/inline":
			for _, job := range []apiclient.Job{missing, existing, inline} {
				if r.URL.Path == "/jobs/"+job.Id {
					_ = json.NewEncoder(w).Encode(job)
				}
			}
		case "/internal/v1/fetch":
			fetches.Add(1)
			_, _ = io.WriteString(w, `{"box_id":"fresh","secrets":[{"name":"A","value":"fetched","hosts":["example.com"],"headers":{"Authorization":"Bearer {value}"}}]}`)
		default:
			if strings.HasPrefix(r.URL.Path, "/computeMetadata/v1/") {
				identities.Add(1)
				_, _ = io.WriteString(w, "test-identity")
				return
			}
			id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/jobs/"), "/status")
			var status apiclient.UpdateJobStatus
			if !strings.HasSuffix(r.URL.Path, "/status") || json.NewDecoder(r.Body).Decode(&status) != nil {
				t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			result := apiclient.NewJob(id, apiclient.JOBTYPE_CREATE_BOX, status.Status, "BOX", id, time.Now().Format(time.RFC3339))
			_ = json.NewEncoder(w).Encode(result)
			reports <- report{id, status}
		}
	}))
	defer api.Close()

	useTestRunnerAPI(t, api.URL)
	t.Setenv("SECRET_SERVER_URL", api.URL)
	t.Setenv("GCE_METADATA_HOST", strings.TrimPrefix(api.URL, "http://"))
	t.Setenv("BOXLITE_RUNNER_ATTESTOR", "gcp_iit")
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	b := &recoveryBackend{creates: make(chan dto.CreateBoxDTO, 4)}
	e, err := executor.NewExecutor(&executor.ExecutorConfig{Backend: b, Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(&PollerServiceConfig{Executor: e, Logger: logger, PollTimeout: time.Second, PollLimit: 4})
	if err != nil {
		t.Fatal(err)
	}
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		service.Start(ctx)
	}()
	defer func() { cancel(); <-stopped }()

	seen := make(map[string]bool, 4)
	for range 4 {
		select {
		case status := <-reports:
			if seen[status.id] {
				t.Fatalf("duplicate terminal status for %s", status.id)
			}
			seen[status.id] = true
			want := apiclient.JOBSTATUS_COMPLETED
			if status.id == missing.Id {
				want = apiclient.JOBSTATUS_FAILED
				if !strings.Contains(status.GetErrorMessage(), "submit a new create request") {
					t.Errorf("missing recovery guidance: %q", status.GetErrorMessage())
				}
			}
			if status.Status != want {
				t.Errorf("job %s = %s, want %s (%s)", status.id, status.Status, want, status.GetErrorMessage())
			}
		case <-ctx.Done():
			t.Fatal("timed out waiting for terminal job reports")
		}
	}
	if got := fetches.Load(); got != 1 {
		t.Errorf("fetch POST count = %d, want 1 for the fresh job only", got)
	}
	if got := identities.Load(); got != 1 {
		t.Errorf("metadata calls = %d, want 1 for the fresh job only", got)
	}
	wantValue := map[string]string{"inline": "inline", "fresh": "fetched"}
	close(b.creates)
	for box := range b.creates {
		if box.Id == existing.Id && box.RequireExisting && len(box.Secrets) == 0 {
			delete(seen, box.Id)
			continue
		}
		value, ok := wantValue[box.Id]
		if !ok || box.RequireExisting || len(box.Secrets) != 1 || box.Secrets[0].Value != value {
			t.Errorf("unexpected create for %s", box.Id)
		}
		delete(seen, box.Id)
	}
	if len(seen) != 1 || !seen[missing.Id] {
		t.Errorf("jobs without a create call = %v, want only %s", seen, missing.Id)
	}
}

func useTestRunnerAPI(t *testing.T, url string) {
	t.Helper()
	t.Setenv("BOXLITE_API_URL", url)
	t.Setenv("BOXLITE_RUNNER_TOKEN", "test-runner-token")
	cfg, err := config.GetConfig()
	if err != nil {
		t.Fatal(err)
	}
	previousURL := cfg.BoxliteApiUrl
	cfg.BoxliteApiUrl = url
	t.Cleanup(func() { cfg.BoxliteApiUrl = previousURL })
}
