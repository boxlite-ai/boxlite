// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package api

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	common_errors "github.com/boxlite-ai/common-go/pkg/errors"
	"github.com/boxlite-ai/runner/pkg/common"
	"github.com/boxlite-ai/runner/pkg/runner/v2/poller"
	"github.com/gin-gonic/gin"
)

func TestJobConcurrencyAPI(t *testing.T) {
	t.Setenv("BOXLITE_API_URL", "http://runner.invalid")
	t.Setenv("BOXLITE_RUNNER_TOKEN", "YOUR_API_KEY")
	t.Setenv("RUNNER_DOMAIN", "localhost")
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	service, err := poller.NewService(&poller.PollerServiceConfig{Logger: logger, PollLimit: 10, MaxConcurrentJobs: 50})
	if err != nil {
		t.Fatal(err)
	}
	server := NewApiServer(ApiServerConfig{Logger: logger, ApiToken: "YOUR_API_KEY", JobPoller: service})
	server.router = gin.New()
	server.router.Use(common_errors.NewErrorMiddleware(common.HandlePossibleDockerError))
	server.registerJobConcurrencyRoutes()
	request := func(method, body, token string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "/config/job-concurrency", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		response := httptest.NewRecorder()
		server.router.ServeHTTP(response, req)
		return response
	}
	for _, method := range []string{http.MethodGet, http.MethodPatch} {
		for _, token := range []string{"", "WRONG_TOKEN"} {
			if response := request(method, `{"maxConcurrentJobs":100}`, token); response.Code != http.StatusUnauthorized {
				t.Fatalf("unauthorized %s: status=%d", method, response.Code)
			}
		}
	}
	if service.MaxConcurrentJobs() != 50 {
		t.Fatal("unauthorized request changed limit")
	}
	for _, body := range []string{`{}`, `null`, `{"maxConcurrentJobs":0}`, `{"maxConcurrentJobs":-1}`, `{"maxConcurrentJobs":1.5}`, `{"maxConcurrentJobs":"100"}`, `{`} {
		response := request(http.MethodPatch, body, "YOUR_API_KEY")
		if response.Code != http.StatusBadRequest || service.MaxConcurrentJobs() != 50 {
			t.Fatalf("invalid update %s: status=%d limit=%d", body, response.Code, service.MaxConcurrentJobs())
		}
	}
	for _, limit := range []int{100, 20} {
		body, _ := json.Marshal(JobConcurrency{MaxConcurrentJobs: limit})
		for _, method := range []string{http.MethodPatch, http.MethodGet} {
			response := request(method, string(body), "YOUR_API_KEY")
			var result JobConcurrency
			if response.Code != http.StatusOK {
				t.Fatalf("%s: status=%d", method, response.Code)
			}
			if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if result.MaxConcurrentJobs != limit || service.MaxConcurrentJobs() != limit {
				t.Fatalf("%s: response=%d actual=%d want=%d", method, result.MaxConcurrentJobs, service.MaxConcurrentJobs(), limit)
			}
		}
	}
}

func TestJobConcurrencyUnavailableWithoutPoller(t *testing.T) {
	server := &ApiServer{router: gin.New()}
	server.registerJobConcurrencyRoutes()
	response := httptest.NewRecorder()
	server.router.ServeHTTP(response, httptest.NewRequest(http.MethodPatch, "/config/job-concurrency", nil))
	if response.Code != http.StatusNotFound {
		t.Fatalf("status=%d, want 404", response.Code)
	}
}
