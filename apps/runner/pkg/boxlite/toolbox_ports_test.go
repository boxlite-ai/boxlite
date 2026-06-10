// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"io"
	"log/slog"
	"net"
	"net/http"
	"testing"
	"time"
)

func TestReserveToolboxHostPortPersistsRecord(t *testing.T) {
	client := &Client{homeDir: t.TempDir(), logger: slog.New(slog.NewTextHandler(io.Discard, nil))}

	first, err := client.reserveToolboxHostPort(t.Context(), "box-1")
	if err != nil {
		t.Fatalf("reserveToolboxHostPort first: %v", err)
	}
	if first < 1 || first > 65535 {
		t.Fatalf("reserved invalid port %d", first)
	}

	second, err := client.reserveToolboxHostPort(t.Context(), "box-1")
	if err != nil {
		t.Fatalf("reserveToolboxHostPort second: %v", err)
	}
	if second != first {
		t.Fatalf("expected persisted port %d, got %d", first, second)
	}

	readBack, err := client.ToolboxHostPort("box-1")
	if err != nil {
		t.Fatalf("ToolboxHostPort: %v", err)
	}
	if readBack != first {
		t.Fatalf("expected read-back port %d, got %d", first, readBack)
	}
}

func TestRemoveToolboxPortRecord(t *testing.T) {
	client := &Client{homeDir: t.TempDir(), logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	if _, err := client.reserveToolboxHostPort(t.Context(), "box-1"); err != nil {
		t.Fatalf("reserveToolboxHostPort: %v", err)
	}

	if err := client.removeToolboxPortRecord(t.Context(), "box-1"); err != nil {
		t.Fatalf("removeToolboxPortRecord: %v", err)
	}

	if _, err := client.ToolboxHostPort("box-1"); err == nil {
		t.Fatal("expected missing toolbox port record after removal")
	}
}

func TestWaitForToolboxReadyReturnsAfterVersionEndpointResponds(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/version", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"version":"test"}`))
	})
	server := &http.Server{Handler: mux}
	go func() {
		_ = server.Serve(listener)
	}()
	defer server.Close()

	port := listener.Addr().(*net.TCPAddr).Port
	client := &Client{
		homeDir:             t.TempDir(),
		logger:              slog.New(slog.NewTextHandler(io.Discard, nil)),
		toolboxReadyTimeout: time.Second,
	}
	if err := client.writeToolboxPortRecord(toolboxPortRecord{
		BoxID: "box-1",
		GuestPort: ToolboxGuestPort,
		HostPort:  port,
	}); err != nil {
		t.Fatalf("writeToolboxPortRecord: %v", err)
	}

	if err := client.waitForToolboxReady(t.Context(), "box-1"); err != nil {
		t.Fatalf("waitForToolboxReady: %v", err)
	}
}

func TestWaitForToolboxReadyTimesOutWhenEndpointDoesNotRespond(t *testing.T) {
	port, err := findAvailableLocalPort()
	if err != nil {
		t.Fatalf("findAvailableLocalPort: %v", err)
	}
	client := &Client{
		homeDir:             t.TempDir(),
		logger:              slog.New(slog.NewTextHandler(io.Discard, nil)),
		toolboxReadyTimeout: 20 * time.Millisecond,
	}
	if err := client.writeToolboxPortRecord(toolboxPortRecord{
		BoxID: "box-1",
		GuestPort: ToolboxGuestPort,
		HostPort:  port,
	}); err != nil {
		t.Fatalf("writeToolboxPortRecord: %v", err)
	}

	if err := client.waitForToolboxReady(t.Context(), "box-1"); err == nil {
		t.Fatal("expected waitForToolboxReady to time out")
	}
}
