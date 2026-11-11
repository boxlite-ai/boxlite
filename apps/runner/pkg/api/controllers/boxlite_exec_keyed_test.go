package controllers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/boxlite"
	"github.com/gin-gonic/gin"
)

// Substitute only the SDK boundary; generation checks, JSON binding, option
// translation and status classification run in the production HTTP handlers.
type recordingExecutionBackend struct {
	info     *sdk.BoxInfo
	infoErr  error
	startErr error
	calls    []boxlite.StartOptions
	boxIDs   []string
}

func (b *recordingExecutionBackend) Info(context.Context) (*sdk.BoxInfo, error) {
	return b.info, b.infoErr
}

func (b *recordingExecutionBackend) Start(_ context.Context, boxID string, options boxlite.StartOptions) (string, error) {
	b.calls = append(b.calls, options)
	b.boxIDs = append(b.boxIDs, boxID)
	return "guest-execution-17", b.startErr
}

func executionHTTP(t *testing.T, backend executionBackend, lookupErr error) *gin.Engine {
	t.Helper()
	previous := getExecutionBackend
	getExecutionBackend = func(_ *gin.Context, id string) (executionBackend, error) {
		if id != "requested-box" {
			t.Fatalf("lookup box = %q", id)
		}
		return backend, lookupErr
	}
	t.Cleanup(func() { getExecutionBackend = previous })
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.GET("/v1/boxes/:boxId/exec-generation", BoxliteExecGeneration)
	router.POST("/v1/boxes/:boxId/exec", BoxliteExec)
	return router
}

func keyedHTTPRequest(router *gin.Engine, method, generation, body string) *httptest.ResponseRecorder {
	path := "/v1/boxes/requested-box/exec"
	if method == http.MethodGet {
		path += "-generation"
	}
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", "request-token")
	if generation != "" {
		req.Header.Set("X-Boxlite-Exec-Generation", generation)
	}
	response := httptest.NewRecorder()
	router.ServeHTTP(response, req)
	return response
}

func TestBoxliteExecGenerationHTTP(t *testing.T) {
	for _, tc := range []struct {
		name      string
		info      *sdk.BoxInfo
		err       error
		lookupErr error
		status    int
	}{
		{"running", &sdk.BoxInfo{ID: "actual-box", Running: true, StartedAt: time.UnixMilli(1700000000123)}, nil, nil, http.StatusOK},
		{"stopped", &sdk.BoxInfo{ID: "actual-box", StartedAt: time.UnixMilli(1700000000123)}, nil, nil, http.StatusConflict},
		{"missing start time", &sdk.BoxInfo{ID: "actual-box", Running: true}, nil, nil, http.StatusConflict},
		{"info failure", nil, errors.New("metadata unavailable"), nil, http.StatusConflict},
		{"missing box", nil, nil, errors.New("missing box"), http.StatusNotFound},
		{"runner unavailable", nil, nil, fmt.Errorf("startup: %w", errExecutionRunnerUnavailable), http.StatusNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			backend := &recordingExecutionBackend{info: tc.info, infoErr: tc.err}
			response := keyedHTTPRequest(executionHTTP(t, backend, tc.lookupErr), http.MethodGet, "", "")
			if response.Code != tc.status {
				t.Fatalf("generation: %d %s, want %d", response.Code, response.Body.String(), tc.status)
			}
			var body map[string]string
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if tc.status == http.StatusOK && body["generation"] != "actual-box:1700000000123" {
				t.Fatalf("generation = %q", body["generation"])
			}
			if tc.status != http.StatusOK && body["error"] == "" {
				t.Fatal("missing error response")
			}
			if len(backend.calls) != 0 {
				t.Fatal("generation endpoint started an execution")
			}
		})
	}
}

func TestBoxliteExecKeyedOptionsHTTP(t *testing.T) {
	backend := &recordingExecutionBackend{info: &sdk.BoxInfo{ID: "actual-box", Running: true, StartedAt: time.UnixMilli(1700000000123)}}
	router := executionHTTP(t, backend, nil)
	response := keyedHTTPRequest(router, http.MethodPost, "actual-box:1700000000123",
		`{"command":"sh","args":["-c","echo hello"],"env":{"K":"V"},"working_dir":"/app","timeout_seconds":1.5,"tty":true,"user":"1000:1000"}`)
	if response.Code != http.StatusCreated {
		t.Fatalf("start: %d %s", response.Code, response.Body.String())
	}
	var result ExecResponse
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.ExecutionID != "guest-execution-17" {
		t.Fatalf("execution id: %q", result.ExecutionID)
	}
	want := boxlite.StartOptions{IdempotencyKey: "request-token", ExpectedStartedAt: 1700000000123,
		Command: "sh", Args: []string{"-c", "echo hello"}, Env: map[string]string{"K": "V"},
		WorkingDir: "/app", Timeout: 1500 * time.Millisecond, TTY: true, User: "1000:1000"}
	if len(backend.calls) != 1 || !reflect.DeepEqual(backend.calls[0], want) || backend.boxIDs[0] != "requested-box" {
		t.Fatalf("SDK start options=%+v boxIDs=%v, want %+v", backend.calls, backend.boxIDs, want)
	}
	// Older callers omit the generation header; that must preserve zero
	// ExpectedStartedAt rather than reusing the previous request's generation.
	response = keyedHTTPRequest(router, http.MethodPost, "", `{"command":"true"}`)
	if response.Code != http.StatusCreated || len(backend.calls) != 2 || backend.calls[1].ExpectedStartedAt != 0 {
		t.Fatalf("legacy start: %d %s calls=%+v", response.Code, response.Body.String(), backend.calls)
	}
}

func TestBoxliteExecKeyedRejectionsHTTP(t *testing.T) {
	for _, tc := range []struct {
		name       string
		generation string
		body       string
		infoErr    error
		startErr   error
		lookupErr  error
		status     int
		starts     int
	}{
		{"stale generation", "actual-box:1", `{"command":"true"}`, nil, nil, nil, 409, 0},
		{"malformed generation", "no-timestamp", `{"command":"true"}`, nil, nil, nil, 409, 0},
		{"info failure", "actual-box:1700000000123", `{"command":"true"}`, errors.New("metadata unavailable"), nil, nil, 409, 0},
		{"invalid json", "", `{`, nil, nil, nil, 400, 0},
		{"missing box", "", `{"command":"true"}`, nil, nil, errors.New("missing box"), 404, 0},
		{"runner unavailable", "", `{"command":"true"}`, nil, nil, errExecutionRunnerUnavailable, 500, 0},
		{"payload mismatch", "", `{"command":"true"}`, nil, &sdk.Error{Code: sdk.ErrInvalidArgument, Message: "idempotency_mismatch: changed payload"}, nil, 422, 1},
		{"retention full", "", `{"command":"true"}`, nil, &sdk.Error{Code: sdk.ErrResourceExhausted, Message: "retention full"}, nil, 429, 1},
		{"expired request", "", `{"command":"true"}`, nil, &sdk.Error{Code: sdk.ErrInvalidState, Message: "execution request expired"}, nil, 409, 1},
		{"invalid user", "", `{"command":"true"}`, nil, &sdk.Error{Code: sdk.ErrInvalidArgument, Message: "unknown user"}, nil, 400, 1},
		{"SDK fault", "", `{"command":"true"}`, nil, errors.New("transport failed"), nil, 500, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			backend := &recordingExecutionBackend{info: &sdk.BoxInfo{ID: "actual-box", Running: true, StartedAt: time.UnixMilli(1700000000123)}, infoErr: tc.infoErr, startErr: tc.startErr}
			response := keyedHTTPRequest(executionHTTP(t, backend, tc.lookupErr), http.MethodPost, tc.generation, tc.body)
			if response.Code != tc.status || len(backend.calls) != tc.starts {
				t.Fatalf("response=%d %s starts=%d, want %d starts=%d", response.Code, response.Body.String(), len(backend.calls), tc.status, tc.starts)
			}
			var body map[string]string
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body["error"] == "" {
				t.Fatal("missing error response")
			}
		})
	}
}
