// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package main

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/boxlite-ai/proxy/cmd/proxy/config"
)

func TestInitLoggerExportsProxyLogsOverOTLP(t *testing.T) {
	previousLogger := slog.Default()
	defer slog.SetDefault(previousLogger)

	type otlpRequest struct {
		contentType string
		body        []byte
	}
	requests := make(chan otlpRequest, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/logs" {
			t.Errorf("request path = %q, want /v1/logs", request.URL.Path)
		}
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Errorf("read request body: %v", err)
			writer.WriteHeader(http.StatusInternalServerError)
			return
		}
		requests <- otlpRequest{
			contentType: request.Header.Get("Content-Type"),
			body:        body,
		}
		writer.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	baseLogger := slog.New(slog.NewTextHandler(io.Discard, nil))
	_, shutdown, err := initLogger(context.Background(), baseLogger, &config.Config{
		OtelLoggingEnabled: true,
		OtelEndpoint:       server.URL,
		Environment:        "test",
	})
	if err != nil {
		t.Fatalf("initLogger() error = %v", err)
	}

	slog.Info("proxy OTLP test log", "component", "proxy-test")
	shutdown()

	select {
	case request := <-requests:
		if request.contentType != "application/x-protobuf" {
			t.Errorf("content type = %q, want application/x-protobuf", request.contentType)
		}
		assertProxyOTLPPayload(t, request.body)
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for OTLP log export")
	}
}

func assertProxyOTLPPayload(t *testing.T, body []byte) {
	t.Helper()

	for _, expected := range []string{"service.name", "boxlite-proxy", "proxy OTLP test log", "component", "proxy-test"} {
		if !bytes.Contains(body, []byte(expected)) {
			t.Errorf("protobuf payload does not contain %q", expected)
		}
	}
}
