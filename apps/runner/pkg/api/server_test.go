// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package api

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/boxlite-ai/runner/cmd/runner/config"
)

func TestApiServerRejectsOccupiedListener(t *testing.T) {
	t.Setenv("BOXLITE_LISTEN_HOST", "127.0.0.1")
	held, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer held.Close()
	server := NewApiServer(ApiServerConfig{
		Logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
		ApiPort: held.Addr().(*net.TCPAddr).Port,
	})
	err = server.Start(context.Background())
	if err == nil || !strings.Contains(err.Error(), "already in use") {
		t.Fatalf("Start on an occupied address = %v", err)
	}
}

func TestApiServerListensOnConfiguredHost(t *testing.T) {
	t.Setenv("BOXLITE_LISTEN_HOST", "127.0.0.1")
	t.Setenv("BOXLITE_API_URL", "http://127.0.0.1")
	t.Setenv("BOXLITE_RUNNER_TOKEN", "listener-test")
	t.Setenv("RUNNER_DOMAIN", "127.0.0.1")
	t.Setenv("ENVIRONMENT", "production")
	if _, err := config.GetConfig(); err != nil {
		t.Fatal(err)
	}
	held, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := held.Addr().String()
	port := held.Addr().(*net.TCPAddr).Port
	held.Close()
	server := NewApiServer(ApiServerConfig{
		Logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
		ApiPort: port,
	})
	done := make(chan error, 1)
	go func() { done <- server.Start(context.Background()) }()
	client := &http.Client{Timeout: time.Second}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case err := <-done:
			t.Fatalf("Start exited before readiness: %v", err)
		default:
		}
		response, err := client.Get("http://" + address + "/")
		if err == nil {
			response.Body.Close()
			server.Stop()
			<-done
			if response.StatusCode != http.StatusOK {
				t.Fatalf("health status = %d", response.StatusCode)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("Runner listener did not become healthy")
}
