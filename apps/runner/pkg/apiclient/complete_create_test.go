// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package apiclient

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	cloud "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
)

func completeCreateTestClient(server *httptest.Server) *cloud.APIClient {
	config := cloud.NewConfiguration()
	config.Servers = cloud.ServerConfigurations{{URL: server.URL + "/api"}}
	config.HTTPClient = server.Client()
	config.AddDefaultHeader("Authorization", "Bearer runner-credential")
	config.AddDefaultHeader(BoxliteSourceHeader, "runner")
	return cloud.NewAPIClient(config)
}

func TestCompleteCreateClaimAndReceiptUseConfiguredCloud(t *testing.T) {
	const lease = "synthetic-complete-lease"
	request := dto.CompleteCreateRequest{
		Attempt: dto.CompleteCreateAttempt{JobID: "job-1", ClaimID: "claim-1", Incarnation: "box-1"},
		Box:     dto.CreateBoxDTO{Id: "box-1"},
	}
	received := make(chan dto.CompleteCreateResult, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost ||
			r.Header.Get("Authorization") != "Bearer runner-credential" ||
			r.Header.Get(BoxliteSourceHeader) != "runner" ||
			r.Header.Get("X-BoxLite-Complete-Lease") != lease {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		switch r.URL.Path {
		case "/api/jobs/complete-outbound/claim":
			_ = json.NewEncoder(w).Encode(map[string]any{"request": request})
		case "/api/jobs/complete-outbound/job-1/receipt":
			var receipt dto.CompleteCreateResult
			if err := json.NewDecoder(r.Body).Decode(&receipt); err != nil {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			received <- receipt
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	client := completeCreateTestClient(server)
	claimed, err := ClaimCompleteCreate(t.Context(), client, lease)
	if err != nil || claimed == nil || claimed.Attempt.JobID != "job-1" ||
		claimed.Attempt.ClaimID != "claim-1" || claimed.Box.Id != "box-1" {
		t.Fatalf("expected bound job, got %+v, %v", claimed, err)
	}
	if err := ReportCompleteCreate(t.Context(), client, lease, dto.CompleteCreateResult{
		Attempt: claimed.Attempt, Outcome: dto.CompleteCreateNoEffect, Failure: "unsupported",
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-received:
		if got.Attempt.JobID != "job-1" || got.Attempt.ClaimID != "claim-1" ||
			got.Outcome != dto.CompleteCreateNoEffect || got.Failure != "unsupported" {
			t.Fatalf("unexpected receipt %+v", got)
		}
	default:
		t.Fatal("Cloud did not receive a receipt")
	}
}

func TestCompleteCreateClaimDoesNotForwardLeaseOnRedirect(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("claim followed the redirect")
		w.WriteHeader(http.StatusForbidden)
	}))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	if request, err := ClaimCompleteCreate(t.Context(), completeCreateTestClient(server), "synthetic"); request != nil || err == nil {
		t.Fatalf("expected redirect refusal, got %+v, %v", request, err)
	}
}
