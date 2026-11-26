// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

//go:build boxlite_dev

package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	commonerrors "github.com/boxlite-ai/common-go/pkg/errors"
	"github.com/boxlite-ai/runner/cmd/runner/config"
	"github.com/boxlite-ai/runner/pkg/api/middlewares"
	blclient "github.com/boxlite-ai/runner/pkg/boxlite"
	"github.com/boxlite-ai/runner/pkg/common"
	"github.com/boxlite-ai/runner/pkg/models/enums"
	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

func TestProtectedAllocationHTTPRequiresEnrolledTLSAndBearer(t *testing.T) {
	t.Setenv("ENVIRONMENT", "development")
	t.Setenv("BOXLITE_API_URL", "https://example.invalid")
	t.Setenv("BOXLITE_RUNNER_TOKEN", "local-test")
	t.Setenv("RUNNER_DOMAIN", "runner.example.invalid")
	env, err := config.GetConfig()
	if err != nil {
		t.Fatal(err)
	}
	originalEnvironment := env.Environment
	env.Environment = "development"
	t.Cleanup(func() { env.Environment = originalEnvironment })
	client, err := blclient.NewClient(t.Context(), blclient.ClientConfig{
		HomeDir: t.TempDir(), VolumeCleanupDryRun: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	if _, err := runner.GetInstance(&runner.RunnerInstanceConfig{Boxlite: client}); err != nil {
		t.Fatal(err)
	}

	const token = "test-token"
	cfg := ProtectedBootConfig{
		RunnerID: uuid.NewString(), DoHURL: "https://resolver.example.com/dns-query", DoHAddress: "1.1.1.1:443",
	}
	engine := gin.New()
	engine.Use(commonerrors.NewErrorMiddleware(common.HandlePossibleDockerError))
	registerProtectedBoot(engine.Group("/", middlewares.AuthMiddleware(token)), cfg, 0, true)
	tls, plain := httptest.NewTLSServer(engine), httptest.NewServer(engine)
	t.Cleanup(tls.Close)
	t.Cleanup(plain.Close)

	boxID, attempt := uuid.NewString(), uuid.NewString()
	path := "/v1/boxes/" + boxID + "/network/outbound/bootstrap/allocation/" + attempt
	payload := `{"id":"` + boxID + `","osUser":"root","image":"alpine:latest","memoryQuota":1,"storageQuota":1,"outboundEnabled":false}`
	send := func(server *httptest.Server, method, bearer, runnerID string, status int, state string) {
		t.Helper()
		request, err := http.NewRequestWithContext(t.Context(), method, server.URL+path, strings.NewReader(payload))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Authorization", "Bearer "+bearer)
		request.Header.Set("X-BoxLite-Runner-Id", runnerID)
		response, err := server.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != status {
			t.Fatalf("%s HTTP status %d, expected %d", method, response.StatusCode, status)
		}
		if state != "" {
			var receipt map[string]string
			if err := json.NewDecoder(response.Body).Decode(&receipt); err != nil || receipt["state"] != state ||
				receipt["box_id"] != boxID || receipt["attempt_id"] != attempt {
				t.Fatalf("%s returned the wrong exact receipt: %v (%v)", method, receipt, err)
			}
		}
	}
	for _, method := range []string{http.MethodPost, http.MethodDelete} {
		send(plain, method, token, cfg.RunnerID, http.StatusForbidden, "")
		send(tls, method, "wrong", cfg.RunnerID, http.StatusUnauthorized, "")
		send(tls, method, token, uuid.NewString(), http.StatusForbidden, "")
	}
	info, err := client.GetBoxInfo(t.Context(), boxID)
	if err != nil || info.BoxState != enums.BoxStateUnknown {
		t.Fatalf("rejected allocation must leave the Runner without a Box: %v (%v)", info.BoxState, err)
	}
	send(tls, http.MethodPost, token, cfg.RunnerID, http.StatusCreated, "allocated")
	send(tls, http.MethodDelete, "wrong", cfg.RunnerID, http.StatusUnauthorized, "")
	info, err = client.GetBoxInfo(t.Context(), boxID)
	if err != nil || info.BoxState != enums.BoxStateCreating {
		t.Fatalf("rejected closure must retain the same configured Box: %v (%v)", info.BoxState, err)
	}
	send(tls, http.MethodDelete, token, cfg.RunnerID, http.StatusOK, "closed")
	send(tls, http.MethodPost, token, cfg.RunnerID, http.StatusConflict, "")
}
