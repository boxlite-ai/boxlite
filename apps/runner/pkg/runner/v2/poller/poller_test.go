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
	"sync/atomic"
	"testing"
	"time"

	cloud "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/runner/v2/executor"
)

func TestProtectedCreatesDrainWhileOrdinaryQueueIsBlocked(t *testing.T) {
	const queued = 3
	const lease = "fixture-protected-lease"
	var requests atomic.Int32
	delivered := make(chan string, queued)
	ordinary := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/jobs":
			ordinary <- struct{}{}
			<-r.Context().Done()
		case "/api/jobs/complete-outbound/claim":
			if r.Method != http.MethodPost || r.Header.Get("X-BoxLite-Complete-Lease") != lease {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			number := requests.Add(1)
			if number > queued {
				_ = json.NewEncoder(w).Encode(map[string]any{"request": nil})
				return
			}
			id := fmt.Sprintf("box-%d", number)
			request := &dto.CompleteCreateRequest{
				Attempt: dto.CompleteCreateAttempt{JobID: fmt.Sprintf("job-%d", number), ClaimID: "fixture-claim", Incarnation: id},
				Box:     dto.CreateBoxDTO{Id: id},
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"request": request})
			delivered <- request.Attempt.JobID
		default:
			t.Errorf("unexpected Runner API path: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()

	t.Setenv("BOXLITE_API_URL", server.URL+"/api")
	t.Setenv("BOXLITE_RUNNER_TOKEN", "fixture-runner-key")
	t.Setenv("RUNNER_DOMAIN", "localhost")
	t.Setenv("ENVIRONMENT", "development")
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	execute, err := executor.NewExecutor(&executor.ExecutorConfig{Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	settings := cloud.NewConfiguration()
	settings.Servers = cloud.ServerConfigurations{{URL: server.URL + "/api"}}
	settings.HTTPClient = server.Client()
	s := &Service{log: logger, pollTimeout: 30 * time.Second, pollLimit: 1,
		client: cloud.NewAPIClient(settings), executor: execute, completeLease: lease}
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.Start(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	select {
	case <-ordinary:
	case <-ctx.Done():
		t.Fatal("ordinary queue request never reached the fixture")
	}
	for count := 1; count <= queued; count++ {
		select {
		case job := <-delivered:
			if want := fmt.Sprintf("job-%d", count); want != job {
				t.Fatalf("delivered %s, want %s", job, want)
			}
		case <-ctx.Done():
			t.Fatalf("only %d protected jobs arrived while the ordinary queue was blocked", count-1)
		}
	}
}
