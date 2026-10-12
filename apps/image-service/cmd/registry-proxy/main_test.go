// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"syscall"
	"testing"
	"time"

	"github.com/boxlite-ai/image-service/cmd/registry-proxy/config"
	"github.com/boxlite-ai/image-service/internal/proxy"
)

// Logs are how a pull that failed upstream is explained after the fact, so the
// wiring that sends them has to reach a collector and arrive labelled as this
// service rather than as whichever service was copied from.
func TestInitLoggerExportsRegistryProxyLogsOverOTLP(t *testing.T) {
	previous := slog.Default()
	t.Cleanup(func() { slog.SetDefault(previous) })

	payloads := make(chan []byte, 1)
	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/logs" {
			t.Errorf("request path = %q, want /v1/logs", r.URL.Path)
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read request body: %v", err)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		payloads <- body
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(collector.Close)

	_, shutdown, err := initLogger(context.Background(), slog.New(slog.NewTextHandler(io.Discard, nil)), &config.Config{
		OtelLoggingEnabled: true,
		OtelEndpoint:       collector.URL,
		Environment:        "test",
	})
	if err != nil {
		t.Fatalf("initLogger() failed: %v", err)
	}

	slog.Info("registry proxy OTLP test log", "component", "registry-proxy-test")
	shutdown()

	select {
	case payload := <-payloads:
		for _, expected := range []string{
			"service.name", proxy.ServiceName,
			"registry proxy OTLP test log", "component", "registry-proxy-test",
		} {
			if !bytes.Contains(payload, []byte(expected)) {
				t.Errorf("exported payload does not carry %q", expected)
			}
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for the OTLP log export")
	}
}

// With no collector configured there is nothing to export to, and a process
// that fails to start over that would make telemetry a hard dependency of
// serving pulls.
func TestInitLoggerLeavesTheLoggerAloneWithoutACollector(t *testing.T) {
	base := slog.New(slog.NewTextHandler(io.Discard, nil))

	for _, cfg := range []*config.Config{
		{OtelLoggingEnabled: false, OtelEndpoint: "http://collector.invalid"},
		{OtelLoggingEnabled: true, OtelEndpoint: ""},
	} {
		logger, shutdown, err := initLogger(context.Background(), base, cfg)
		if err != nil {
			t.Fatalf("initLogger() failed: %v", err)
		}
		if logger != base {
			t.Error("the logger was replaced although no collector is configured")
		}
		shutdown()
	}
}

func TestTelemetryConfigCarriesTheParsedHeaders(t *testing.T) {
	got := telemetryConfig(&config.Config{
		OtelEndpoint: "http://collector.invalid",
		OtelHeaders:  "authorization=Bearer abc,x-tenant=acme",
		Environment:  "dev",
	})

	if got.ServiceName != proxy.ServiceName {
		t.Errorf("ServiceName = %q, want %q", got.ServiceName, proxy.ServiceName)
	}
	if got.Headers["authorization"] != "Bearer abc" || got.Headers["x-tenant"] != "acme" {
		t.Errorf("Headers = %v, want both pairs split out of the single variable", got.Headers)
	}
	if got.Environment != "dev" {
		t.Errorf("Environment = %q, want %q", got.Environment, "dev")
	}
}

func discardLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// The first signal must drain rather than exit, because a blob stream in flight
// is an image being assembled and cutting it costs the puller the whole pull.
func TestAwaitDrainsOnTheFirstSignalAndReportsACleanExit(t *testing.T) {
	signals := make(chan os.Signal, 1)
	serveErr := make(chan error, 1)
	drained := make(chan struct{})

	status := make(chan int, 1)
	go func() { status <- await(discardLogger(), signals, serveErr, func() { close(drained) }) }()

	signals <- syscall.SIGTERM
	select {
	case <-drained:
	case <-time.After(2 * time.Second):
		t.Fatal("the first signal did not start a drain")
	}

	// await is still waiting: the drain is what ends the server, and the server
	// is what ends await.
	select {
	case got := <-status:
		t.Fatalf("await returned %d while the drain was still running", got)
	case <-time.After(50 * time.Millisecond):
	}

	serveErr <- nil
	if got := waitForStatus(t, status); got != 0 {
		t.Errorf("await = %d, want 0 after a clean drain", got)
	}
}

// A shutdown delivered as a burst is one shutdown. Reading the burst as "force"
// would turn every restart into a hard kill and truncate whatever was streaming.
func TestAwaitIgnoresASecondSignalInsideTheDebounceWindow(t *testing.T) {
	signals := make(chan os.Signal, 2)
	serveErr := make(chan error, 1)
	drains := make(chan struct{}, 4)

	status := make(chan int, 1)
	go func() { status <- await(discardLogger(), signals, serveErr, func() { drains <- struct{}{} }) }()

	signals <- syscall.SIGTERM
	signals <- syscall.SIGTERM
	select {
	case got := <-status:
		t.Fatalf("await returned %d on a burst that is one shutdown", got)
	case <-time.After(50 * time.Millisecond):
	}
	if len(drains) != 1 {
		t.Errorf("drain ran %d times, want once for one shutdown", len(drains))
	}

	serveErr <- nil
	if got := waitForStatus(t, status); got != 0 {
		t.Errorf("await = %d, want 0", got)
	}
}

// A signal that arrives well after the drain started is an operator saying they
// will not wait, and abandoning the drain is the answer.
func TestAwaitForcesExitOnADeliberateSecondSignal(t *testing.T) {
	signals := make(chan os.Signal, 1)
	serveErr := make(chan error, 1)

	status := make(chan int, 1)
	go func() { status <- await(discardLogger(), signals, serveErr, func() {}) }()

	signals <- syscall.SIGTERM
	time.Sleep(2 * signalDebounce)
	signals <- syscall.SIGINT

	if got := waitForStatus(t, status); got != 1 {
		t.Errorf("await = %d, want 1 when the drain is abandoned", got)
	}
}

// A server that stops on its own with an error has to be reported as a failed
// process, or a crash-looping revision reads as a healthy one.
func TestAwaitReportsAServerThatFailedOnItsOwn(t *testing.T) {
	serveErr := make(chan error, 1)
	serveErr <- errors.New("listen: address already in use")

	if got := await(discardLogger(), make(chan os.Signal), serveErr, func() {}); got != 1 {
		t.Errorf("await = %d, want 1 when the server failed", got)
	}
}

func waitForStatus(t *testing.T, status <-chan int) int {
	t.Helper()
	select {
	case got := <-status:
		return got
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for await to return")
		return -1
	}
}

// The deployed shutdown path end to end: the platform replaces a revision by
// sending SIGTERM, and a process that answers it with anything but a drain and
// a zero exit makes every deploy look like a crash.
func TestRunServesThenDrainsOnSIGTERM(t *testing.T) {
	previous := slog.Default()
	t.Cleanup(func() { slog.SetDefault(previous) })

	t.Setenv("BOXLITE_API_URL", "https://api.invalid")
	t.Setenv("REGISTRY_PROXY_PORT", strconv.Itoa(freePort(t)))
	t.Setenv("SHUTDOWN_TIMEOUT_SEC", "10")
	t.Setenv("OTEL_LOGGING_ENABLED", "false")
	t.Setenv("OTEL_TRACING_ENABLED", "false")

	status := make(chan int, 1)
	go func() { status <- run() }()

	health := "http://127.0.0.1:" + os.Getenv("REGISTRY_PROXY_PORT") + proxy.HealthPath
	waitUntilServing(t, health)

	// Safe only because run() registers its handler before it starts serving,
	// and serving is what the health check above just proved.
	if err := syscall.Kill(os.Getpid(), syscall.SIGTERM); err != nil {
		t.Fatalf("signal self: %v", err)
	}

	if got := waitForStatus(t, status); got != 0 {
		t.Errorf("run() = %d, want 0 after SIGTERM", got)
	}
}

func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port
}

func waitUntilServing(t *testing.T, url string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		response, err := http.Get(url)
		if err == nil {
			response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("%s never answered", url)
}

// Without a control plane there is no checking any caller, so the process must
// refuse to start rather than come up and refuse every pull.
func TestRunRefusesToStartWithoutAControlPlane(t *testing.T) {
	previous := slog.Default()
	t.Cleanup(func() { slog.SetDefault(previous) })
	t.Setenv("BOXLITE_API_URL", "")

	if got := run(); got != 2 {
		t.Errorf("run() without a control plane = %d, want 2", got)
	}
}
