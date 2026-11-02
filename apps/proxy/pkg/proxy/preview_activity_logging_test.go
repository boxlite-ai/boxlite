// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"testing"
)

type previewLogBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (b *previewLogBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.Write(p)
}
func (b *previewLogBuffer) text() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.String()
}

type previewRoundTripper func(*http.Request) (*http.Response, error)

func (f previewRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestPreviewActivityDiagnosticsAreSanitized(t *testing.T) {
	for _, kind := range []string{"http_status_401", "http_status_503", "transport", "timeout", "endpoint"} {
		t.Run(kind, func(t *testing.T) {
			var output previewLogBuffer
			previous := slog.Default()
			slog.SetDefault(slog.New(slog.NewJSONHandler(&output, nil)))
			t.Cleanup(func() { slog.SetDefault(previous) })
			proxy := newTunnelProxy(t, http.StatusOK)
			configuration := proxy.apiclient.GetConfig()
			configuration.HTTPClient = &http.Client{Transport: previewRoundTripper(func(_ *http.Request) (*http.Response, error) {
				if kind == "transport" {
					return nil, errors.New("private-transport-secret")
				}
				if kind == "timeout" {
					return nil, context.DeadlineExceeded
				}
				status := http.StatusUnauthorized
				if kind == "http_status_503" {
					status = http.StatusServiceUnavailable
				}
				return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader("private-response-secret"))}, nil
			})}
			if kind == "endpoint" {
				configuration.Servers[0].URL = "https://private-url-secret@example.test/%zz"
			}
			proxy.recordPreviewOpen(context.Background(), "AbCdEf123456")
			logged := output.text()
			operation := kind
			if kind == "transport" || kind == "timeout" {
				operation = "deliver"
			}
			if !strings.Contains(logged, `"operation":"`+operation+`"`) || !strings.Contains(logged, `"error":`) {
				t.Fatalf("missing safe cause: %s", logged)
			}
			if !strings.Contains(logged, `"box":"AbCdEf123456"`) || strings.Contains(logged, "private-") {
				t.Fatalf("missing box or leaked error details: %s", logged)
			}
			if kind == "timeout" && !strings.Contains(logged, `"error":"timeout"`) {
				t.Fatal(logged)
			}
		})
	}
}
