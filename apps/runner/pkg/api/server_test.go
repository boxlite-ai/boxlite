// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/boxlite-ai/runner/cmd/runner/config"
	"github.com/google/uuid"
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
	const token = "listener-test"
	server := NewApiServer(ApiServerConfig{
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		ApiPort:  port,
		ApiToken: token,
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
			defer func() {
				server.Stop()
				<-done
			}()
			if response.StatusCode != http.StatusOK {
				t.Fatalf("health status = %d", response.StatusCode)
			}
			t.Run("timing route", func(t *testing.T) {
				checkTimingRoute(t, client, "http://"+address, token)
			})
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("Runner listener did not become healthy")
}

func checkTimingRoute(t *testing.T, client *http.Client, baseURL, token string) {
	t.Helper()
	known := "timing-route-" + uuid.NewString()
	// No runner instance is initialized in this test, so exec fails before box lookup.
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, baseURL+"/v1/boxes/"+known+"/exec", strings.NewReader(`{"command":"true"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusInternalServerError {
		t.Fatalf("exec status = %d, want %d", res.StatusCode, http.StatusInternalServerError)
	}

	for _, tc := range []struct {
		name, boxID, header, auth string
		code, count               int
	}{
		{"no token", known, "", "", http.StatusUnauthorized, 0},
		{"wrong token", known, "Authorization", "Bearer wrong", http.StatusUnauthorized, 0},
		{"known", known, "Authorization", "Bearer " + token, http.StatusOK, 1},
		{"unknown", "timing-route-unknown", "X-BoxLite-Authorization", "Bearer " + token, http.StatusOK, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, baseURL+"/timing/"+tc.boxID, nil)
			if err != nil {
				t.Fatal(err)
			}
			if tc.header != "" {
				req.Header.Set(tc.header, tc.auth)
			}
			res, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			if res.StatusCode != tc.code {
				t.Fatalf("status = %d, want %d", res.StatusCode, tc.code)
			}
			if tc.code != http.StatusOK {
				return
			}
			var body struct {
				BoxID  string                       `json:"box_id"`
				Events []map[string]json.RawMessage `json:"events"`
			}
			if err := json.NewDecoder(res.Body).Decode(&body); err != nil || body.BoxID != tc.boxID || body.Events == nil || len(body.Events) != tc.count {
				t.Fatalf("response = %+v (decode error: %v), want box %q and array of %d events", body, err, tc.boxID, tc.count)
			}
			if tc.count == 0 {
				return
			}
			e := body.Events[0]
			if len(e) != 6 || e["dur_ms"] == nil || e["ts"] == nil {
				t.Fatalf("unexpected event fields: %v", e)
			}
			for k, want := range map[string]string{
				"op": "exec", "stage": "exec.request", "status": "error", "box_id": known,
			} {
				var got string
				if err := json.Unmarshal(e[k], &got); err != nil || got != want {
					t.Fatalf("%s = %q (%v), want %q", k, got, err, want)
				}
			}
		})
	}
}
