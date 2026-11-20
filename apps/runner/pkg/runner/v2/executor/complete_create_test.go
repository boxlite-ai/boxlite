// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package executor

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	cloud "github.com/boxlite-ai/boxlite/libs/api-client-go"
	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/cmd/runner/config"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	runnerapiclient "github.com/boxlite-ai/runner/pkg/apiclient"
	"github.com/boxlite-ai/runner/pkg/backend"
	"github.com/boxlite-ai/runner/pkg/boxlite"
)

func TestIntegrationCompleteCreateExecutorReportsLiveInstallation(t *testing.T) {
	const target, lease, bearer = "complete-executor-live", "synthetic-lease", "synthetic-runner-token"
	t.Setenv("BOXLITE_API_URL", "http://127.0.0.1")
	t.Setenv("BOXLITE_RUNNER_TOKEN", bearer)
	t.Setenv("RUNNER_DOMAIN", "localhost")
	t.Setenv("ENVIRONMENT", "development")
	if _, err := config.GetConfig(); err != nil {
		t.Fatal(err)
	}
	ctx := t.Context()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	client, err := boxlite.NewClient(ctx, boxlite.ClientConfig{HomeDir: t.TempDir(), Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	defer client.Destroy(ctx, target)
	prepared, err := client.PrepareOutboundCreate(ctx, "rev-executor",
		json.RawMessage(`{"mode":"enabled","deny_net":["example.test:443"]}`))
	if err != nil {
		t.Fatal(err)
	}
	job := dto.CompleteCreateRequest{
		Attempt: dto.CompleteCreateAttempt{
			Incarnation: target, AttemptID: "attempt-1", Generation: 1, JobID: "job-1", ClaimID: "claim-1",
			Prepared: dto.CompleteCreatePolicy{Snapshot: prepared.Snapshot, DenyPresent: &prepared.DenyPresent},
		},
		Box: dto.CreateBoxDTO{Id: target, Image: "alpine", MemoryQuota: 1},
	}
	receipts := make(chan dto.CompleteCreateResult, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.Header.Get("X-BoxLite-Complete-Lease") != lease ||
			r.Header.Get("Authorization") != "Bearer "+bearer {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		switch r.URL.Path {
		case "/api/jobs/complete-outbound/claim":
			_ = json.NewEncoder(w).Encode(map[string]any{"request": job})
		case "/api/jobs/complete-outbound/job-1/receipt":
			var proof dto.CompleteCreateResult
			if err := json.NewDecoder(r.Body).Decode(&proof); err != nil {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			receipts <- proof
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	cfg := cloud.NewConfiguration()
	cfg.Servers = cloud.ServerConfigurations{{URL: server.URL + "/api"}}
	cfg.HTTPClient = server.Client()
	cfg.AddDefaultHeader("Authorization", "Bearer "+bearer)
	apiClient := cloud.NewAPIClient(cfg)
	executor := &Executor{client: apiClient, backend: backend.NewBoxliteAdapter(client), log: logger}
	claim, err := runnerapiclient.ClaimCompleteCreate(ctx, apiClient, lease)
	if err != nil || claim == nil {
		t.Fatalf("could not claim complete create: claim=%+v err=%v", claim, err)
	}
	executor.ExecuteCompleteCreate(ctx, lease, *claim)

	status, err := client.CompleteOutboundStatus(ctx, target)
	if err != nil || status.Observed == nil || status.ApplicationState != sdk.OutboundConfirmed ||
		status.Observed.ApplicationState != sdk.OutboundConfirmed {
		t.Fatalf("native status did not confirm installation: status=%+v err=%v", status, err)
	}
	select {
	case receipt := <-receipts:
		if receipt.Outcome != dto.CompleteCreateInstalled || receipt.Snapshot == nil ||
			!reflect.DeepEqual(receipt.Attempt, job.Attempt) ||
			!reflect.DeepEqual(*receipt.Snapshot, status.Persisted) ||
			!reflect.DeepEqual(*receipt.Snapshot, status.Observed.Snapshot) {
			t.Fatalf("Cloud received unexpected proof: receipt=%+v status=%+v", receipt, status)
		}
	default:
		t.Fatal("executor did not report terminal proof to Cloud")
	}
}
