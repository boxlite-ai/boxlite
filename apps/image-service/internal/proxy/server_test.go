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
	NewRouter(&config.Config{}, nil).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, HealthPath, nil))

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

// A client reads the version check to decide whether to send a credential at
// all. Answered 200 with no challenge, it concludes none is wanted and sends
// none, and every pull after it is refused for a reason the operator cannot see
// from the configuration — so an unauthenticated version check must challenge.
func TestRouterChallengesAnUnauthenticatedVersionCheck(t *testing.T) {
	recorder := httptest.NewRecorder()
	NewRouter(&config.Config{}, nil).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v2/", nil))

	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("GET /v2/ = %d, want 401", recorder.Code)
	}
	if got := recorder.Header().Get("Www-Authenticate"); got != `Basic realm="`+Realm+`"` {
		t.Errorf("challenge = %q, want a Basic challenge naming this proxy", got)
	}
}

// A path that is not a pull endpoint must not be mistaken for one.
func TestRouterDoesNotServeWritesOrDiscovery(t *testing.T) {
	router := NewRouter(&config.Config{}, nil)

	for _, request := range []*http.Request{
		httptest.NewRequest(http.MethodPut, "/v2/acme/ghcr.io/acme/app/manifests/1.2", nil),
		httptest.NewRequest(http.MethodPost, "/v2/acme/ghcr.io/acme/app/blobs/uploads/", nil),
		httptest.NewRequest(http.MethodDelete, "/v2/acme/ghcr.io/acme/app/manifests/1.2", nil),
	} {
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusNotFound {
			t.Errorf("%s %s = %d, want 404", request.Method, request.URL.Path, recorder.Code)
		}
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
	go func() { served <- serve(ctx, listener, NewRouter(&config.Config{}, nil), 5*time.Second) }()

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
	err = Start(ctx, &config.Config{Port: port, ShutdownTimeoutSec: 1}, nil)
	if err == nil {
		t.Fatalf("Start bound port %d although it is already held", port)
	}
	if !strings.Contains(err.Error(), strconv.Itoa(port)) {
		t.Errorf("error %q does not name the port it failed on", err)
	}
}

// Cloud Run caps an HTTP/1 response at 32 MiB unless it is chunked, and a blob
// relayed with the upstream's Content-Length is not — so a layer past that size
// would fail in production while every local test passed. HTTP/2 carries no such
// cap, and Cloud Run speaks it to a container that accepts it in the clear.
func TestServeSpeaksHTTP2InTheClear(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = serve(ctx, listener, NewRouter(&config.Config{}, nil), time.Second) }()

	// Prior knowledge, which is how Cloud Run opens the connection: no TLS and
	// no Upgrade dance, the HTTP/2 preface straight away.
	protocols := new(http.Protocols)
	protocols.SetUnencryptedHTTP2(true)
	client := &http.Client{Transport: &http.Transport{Protocols: protocols}, Timeout: 5 * time.Second}

	response, err := client.Get("http://" + listener.Addr().String() + HealthPath)
	if err != nil {
		t.Fatalf("an HTTP/2 client could not reach the server: %v", err)
	}
	defer response.Body.Close()
	if response.ProtoMajor != 2 {
		t.Errorf("answered over %s, want HTTP/2", response.Proto)
	}
}

// The same port still has to answer HTTP/1, which is what a developer's curl and
// the local stack's runner speak.
func TestServeStillSpeaksHTTP1(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = serve(ctx, listener, NewRouter(&config.Config{}, nil), time.Second) }()

	protocols := new(http.Protocols)
	protocols.SetHTTP1(true)
	client := &http.Client{Transport: &http.Transport{Protocols: protocols}, Timeout: 5 * time.Second}

	response, err := client.Get("http://" + listener.Addr().String() + HealthPath)
	if err != nil {
		t.Fatalf("an HTTP/1 client could not reach the server: %v", err)
	}
	defer response.Body.Close()
	if response.ProtoMajor != 1 {
		t.Errorf("answered over %s, want HTTP/1.1", response.Proto)
	}
}
