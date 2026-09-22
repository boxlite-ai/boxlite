// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/boxlite-ai/image-service/cmd/registry-proxy/config"
	"github.com/boxlite-ai/image-service/internal"
)

// The platform decides the process is up by probing this path, so a rename or a
// non-200 stops every deployment from ever reporting ready.
func TestRouterServesHealthWithTheRunningVersion(t *testing.T) {
	recorder := httptest.NewRecorder()
	NewRouter(&config.Config{}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, HealthPath, nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("GET %s = %d, want 200", HealthPath, recorder.Code)
	}

	var body struct {
		Status  string `json:"status"`
		Version string `json:"version"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode %q: %v", recorder.Body.String(), err)
	}
	if body.Status != "ok" {
		t.Errorf("status = %q, want %q", body.Status, "ok")
	}
	if body.Version != internal.Version {
		t.Errorf("version = %q, want the running build's %q", body.Version, internal.Version)
	}
}

// /v2/ belongs to the distribution protocol and no handler claims it yet, so it
// must not be answered by accident.
func TestRouterDoesNotYetServeTheDistributionRoot(t *testing.T) {
	recorder := httptest.NewRecorder()
	NewRouter(&config.Config{}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v2/", nil))

	if recorder.Code != http.StatusNotFound {
		t.Errorf("GET /v2/ = %d, want 404 until the pull endpoints land", recorder.Code)
	}
}

// A blob is one long response, so shutdown that closes the listener truncates
// an image mid-layer and the puller sees a corrupt digest rather than a
// retryable failure. Draining is what makes a deploy safe during a pull.
func TestServeFinishesAResponseAlreadyInFlight(t *testing.T) {
	released := make(chan struct{})
	responding := make(chan struct{})
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(responding)
		<-released
		_, _ = w.Write([]byte("last layer"))
	})

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	served := make(chan error, 1)
	go func() { served <- serve(ctx, listener, handler, 10*time.Second) }()

	body := make(chan string, 1)
	go func() {
		response, err := http.Get("http://" + listener.Addr().String() + "/blob")
		if err != nil {
			body <- "request failed: " + err.Error()
			return
		}
		defer response.Body.Close()
		read, err := io.ReadAll(response.Body)
		if err != nil {
			body <- "read failed: " + err.Error()
			return
		}
		body <- string(read)
	}()

	<-responding
	cancel()        // shutdown starts while the response is still open
	close(released) // and only then does the handler finish writing

	if err := <-served; err != nil {
		t.Errorf("serve returned %v, want a clean drain", err)
	}
	select {
	case got := <-body:
		if got != "last layer" {
			t.Errorf("client read %q, want the response to survive the drain", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for the in-flight response")
	}
}

// Once drained, the port is free: a redeploy binds it again immediately rather
// than failing on an address the old process still holds.
func TestServeStopsListeningAfterTheDrain(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	address := listener.Addr().String()

	ctx, cancel := context.WithCancel(context.Background())
	served := make(chan error, 1)
	go func() { served <- serve(ctx, listener, NewRouter(&config.Config{}), 5*time.Second) }()

	response, err := http.Get("http://" + address + HealthPath)
	if err != nil {
		t.Fatalf("GET %s: %v", HealthPath, err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("GET %s = %d, want 200 while serving", HealthPath, response.StatusCode)
	}

	cancel()
	if err := <-served; err != nil {
		t.Fatalf("serve returned %v, want a clean drain", err)
	}

	rebound, err := net.Listen("tcp", address)
	if err != nil {
		t.Fatalf("the address is still held after the drain: %v", err)
	}
	rebound.Close()
}

// Start refuses a port it cannot bind rather than reporting itself up, so the
// platform never routes a pull at a process that is not listening.
func TestStartFailsOnAPortItCannotBind(t *testing.T) {
	// The wildcard address, because that is what Start binds: holding only
	// 127.0.0.1 leaves 0.0.0.0 free on some platforms and the bind succeeds.
	held, err := net.Listen("tcp", ":0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer held.Close()

	// A bind that unexpectedly succeeds would otherwise serve until the suite
	// times out, which reads as a hang rather than as this assertion failing.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	port := held.Addr().(*net.TCPAddr).Port
	err = Start(ctx, &config.Config{Port: port, ShutdownTimeoutSec: 1})
	if err == nil {
		t.Fatalf("Start bound port %d although it is already held", port)
	}
	if !strings.Contains(err.Error(), strconv.Itoa(port)) {
		t.Errorf("error %q does not name the port it failed on", err)
	}
}
