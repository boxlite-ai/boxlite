// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/common-go/pkg/featureusage"
	"github.com/boxlite-ai/runner/cmd/runner/config"
)

type sshEvidence struct{}

func (sshEvidence) ListInfo(context.Context) ([]boxlite.BoxInfo, error) {
	return []boxlite.BoxInfo{{ID: "native", Name: "CloudBox1234", Running: true}}, nil
}
func (sshEvidence) TakeSSHUsage(context.Context, string) (*boxlite.SSHUsageBatch, error) {
	return &boxlite.SSHUsageBatch{Events: []boxlite.SSHUsageEvent{{ID: "event-1", OccurredAtMS: 1234}}}, nil
}

func TestSSHUsageStartupDeliversEvidenceThroughReporter(t *testing.T) {
	received := make(chan []featureusage.Event, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/telemetry/feature-usage" || r.Header.Get("Authorization") != "Bearer test-token" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		var batch struct{ Events []featureusage.Event }
		if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
			t.Error(err)
		}
		w.WriteHeader(http.StatusNoContent)
		received <- batch.Events
	}))
	defer server.Close()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	stop := startSSHUsage(context.Background(), &config.Config{BoxliteApiUrl: server.URL, ApiToken: "test-token"}, sshEvidence{}, logger)
	defer stop()
	select {
	case events := <-received:
		if len(events) != 1 || events[0].ID != "event-1" || events[0].BoxID != "CloudBox1234" || events[0].Kind != featureusage.SSH || events[0].OccurredAt.UnixMilli() != 1234 {
			t.Fatalf("reported events: %v", events)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("runner did not upload the SSH usage batch")
	}
}

func TestSSHUsageStartupDisablesInvalidOrAbsentConfiguration(t *testing.T) {
	for _, cfg := range []config.Config{{}, {BoxliteApiUrl: "invalid", ApiToken: "test-token"}} {
		stop := startSSHUsage(context.Background(), &cfg, nil, slog.Default())
		stop()
	}
}
