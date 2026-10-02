// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

package api

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/boxlite-ai/runner/cmd/runner/config"
)

// ginNoRouteBody is gin's answer for a path no route matches. Every handler
// this server registers replies JSON or upgrades the connection, so this
// exact body is the signature of "never reached a handler" — which is what
// separates a missing route from a route that ran and refused.
const ginNoRouteBody = "404 page not found"

// startTestApiServer boots the production ApiServer — the real route table,
// the real auth middleware — on a free port and returns its base URL.
//
// It seeds the config singleton first because Start() reads
// config.GetEnvironment(), and that singleton is nil until GetConfig() loads
// it. The singleton is process-wide and cached, so this is the only test in
// the package that may set it.
func startTestApiServer(t *testing.T, token string) string {
	t.Helper()

	t.Setenv("BOXLITE_API_URL", "http://127.0.0.1:1")
	t.Setenv("BOXLITE_RUNNER_TOKEN", token)
	t.Setenv("RUNNER_DOMAIN", "127.0.0.1")
	t.Setenv("ENVIRONMENT", "test")
	if _, err := config.GetConfig(); err != nil {
		t.Fatalf("load runner config: %v", err)
	}

	port := freePort(t)
	server := NewApiServer(ApiServerConfig{
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		ApiPort:  port,
		ApiToken: token,
	})

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	started := make(chan error, 1)
	go func() { started <- server.Start(ctx) }()

	baseURL := fmt.Sprintf("http://127.0.0.1:%d", port)
	awaitHealthy(t, baseURL, started)
	t.Cleanup(server.Stop)
	return baseURL
}

// freePort asks the kernel for an unused port and hands it back. Start()
// binds it itself, so the listener here is closed immediately.
func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		t.Fatalf("release reserved port: %v", err)
	}
	return port
}

// awaitHealthy polls the public health route until the server answers, or
// fails the test if Start() returned an error instead of serving.
func awaitHealthy(t *testing.T, baseURL string, started <-chan error) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case err := <-started:
			t.Fatalf("api server exited before serving: %v", err)
		default:
		}
		resp, err := http.Get(baseURL + "/")
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("api server did not become healthy within 15s")
}

// probe issues an authenticated GET and returns the status and trimmed body.
func probe(t *testing.T, baseURL, path, token string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, baseURL+path, nil)
	if err != nil {
		t.Fatalf("build request for %s: %v", path, err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body of %s: %v", path, err)
	}
	return resp.StatusCode, strings.TrimSpace(string(body))
}

// TestBoxAttachRouteIsRegistered pins the box-level attach path onto the
// production route table.
//
// `boxlite run IMAGE COMMAND` runs COMMAND as the container init, so the CLI
// attaches to the box's main session at GET /v1/boxes/{boxId}/attach — a path
// with no execution id in it. The runner only ever registered the
// execution-scoped shape, so that upgrade fell through to gin's NoRoute and
// `run` could not attach against a deployed stack (issue #1609).
func TestBoxAttachRouteIsRegistered(t *testing.T) {
	const token = "test-runner-token"
	baseURL := startTestApiServer(t, token)

	// Control: the execution-scoped attach has always been registered. If
	// this probe looks unrouted the harness is wrong, not the route table.
	execStatus, execBody := probe(t, baseURL, "/v1/boxes/box-1/executions/exec-1/attach", token)
	if execStatus == http.StatusNotFound && execBody == ginNoRouteBody {
		t.Fatalf("harness broken: the execution-scoped attach route reads as unrouted (%d %q)", execStatus, execBody)
	}

	status, body := probe(t, baseURL, "/v1/boxes/box-1/attach", token)
	if status == http.StatusNotFound && body == ginNoRouteBody {
		t.Fatalf("GET /v1/boxes/{boxId}/attach is not registered: gin answered %d %q", status, body)
	}
}
