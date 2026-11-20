// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/cmd/runner/config"
	"github.com/boxlite-ai/runner/pkg/api/controllers"
	"github.com/boxlite-ai/runner/pkg/api/dto"
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

type completeOutboundEndpoint struct {
	calls    chan string
	snapshot sdk.CompleteOutboundSnapshot
}

func (b completeOutboundEndpoint) PrepareOutboundCreate(_ context.Context, revision string, policy json.RawMessage) (sdk.PreparedOutboundCreate, error) {
	b.calls <- "prepare:" + revision + ":" + string(policy)
	return sdk.PreparedOutboundCreate{Snapshot: b.snapshot, DenyPresent: true}, nil
}

func (b completeOutboundEndpoint) CompleteOutboundSnapshot(_ context.Context, target string) (sdk.CompleteOutboundSnapshot, error) {
	b.calls <- "snapshot:" + target
	return b.snapshot, nil
}

func (b completeOutboundEndpoint) CompleteOutboundStatus(_ context.Context, target string) (sdk.CompleteOutboundStatus, error) {
	b.calls <- "status:" + target
	return sdk.CompleteOutboundStatus{Persisted: b.snapshot, ApplicationState: sdk.OutboundUncertain}, nil
}

func (b completeOutboundEndpoint) CreateCompleteOutbound(_ context.Context, target string, request dto.CompleteCreateRequest) (dto.CompleteCreateResult, error) {
	b.calls <- "create:" + target + ":" + request.Box.Id
	return dto.CompleteCreateResult{Attempt: request.Attempt, Outcome: dto.CompleteCreatePending}, nil
}

func (b completeOutboundEndpoint) CancelCompleteOutboundCreate(_ context.Context, target string, attempt dto.CompleteCreateAttempt) (dto.CompleteCreateResult, error) {
	b.calls <- "cancel:" + target + ":" + attempt.AttemptID
	return dto.CompleteCreateResult{Attempt: attempt, Outcome: dto.CompleteCreateNoEffect}, nil
}

func (b completeOutboundEndpoint) HostedOutbound(_ context.Context, target string, command json.RawMessage) (sdk.HostedOutboundReceipt, error) {
	b.calls <- "hosted:" + target + ":" + string(command)
	return sdk.HostedOutboundReceipt{Outcome: "pending"}, nil
}

func (b completeOutboundEndpoint) RebuildCompleteOutbound(_ context.Context, target string, request dto.CompleteRebuildRequest) (sdk.CompleteOutboundSnapshot, error) {
	b.calls <- "rebuild:" + target
	return b.snapshot, nil
}

func TestApiServerCompleteOutboundBearerBoundary(t *testing.T) {
	const token = "complete-outbound-test-token"
	t.Setenv("BOXLITE_LISTEN_HOST", "127.0.0.1")
	t.Setenv("BOXLITE_API_URL", "http://127.0.0.1")
	t.Setenv("BOXLITE_RUNNER_TOKEN", token)
	t.Setenv("RUNNER_DOMAIN", "localhost")
	t.Setenv("ENVIRONMENT", "production")
	if _, err := config.GetConfig(); err != nil {
		t.Fatal(err)
	}
	reserved, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	base := "http://" + reserved.Addr().String()
	port := reserved.Addr().(*net.TCPAddr).Port
	if err := reserved.Close(); err != nil {
		t.Fatal(err)
	}
	server := NewApiServer(ApiServerConfig{Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), ApiPort: port, ApiToken: token})
	backend := completeOutboundEndpoint{
		calls: make(chan string, 20),
		snapshot: sdk.CompleteOutboundSnapshot{
			Revision: "rev-b", Admission: sdk.OutboundAdmissionExtendedIPv4,
			Policy: sdk.EffectiveOutboundPolicy{Mode: sdk.NetworkModeEnabled, AllowNet: []string{"example.com:443"}, DenyNet: []string{}},
		},
	}
	server.completeOutbound = controllers.NewCompleteOutboundHandlers(func() (controllers.CompleteOutboundControl, error) { return backend, nil })
	done := make(chan error, 1)
	go func() { done <- server.Start(t.Context()) }()
	client := &http.Client{Timeout: time.Second}
	for deadline := time.Now().Add(5 * time.Second); ; {
		select {
		case err := <-done:
			t.Fatalf("Start exited before readiness: %v", err)
		default:
		}
		response, err := client.Get(base + "/")
		if err == nil {
			_ = response.Body.Close()
			t.Cleanup(func() {
				client.CloseIdleConnections()
				server.Stop()
				if err := <-done; !errors.Is(err, http.ErrServerClosed) {
					t.Errorf("Start returned %v when stopped", err)
				}
			})
			if response.StatusCode != http.StatusOK {
				t.Fatalf("health status = %d", response.StatusCode)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("Runner did not become healthy: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}

	const path = "/v1/boxes/target/network/outbound/complete"
	const policy = `{"mode":"enabled","allow_net":["example.com:443"],"deny_net":[]}`
	for _, route := range []struct {
		method, suffix, body, wantCall string
	}{
		{http.MethodPost, "/prepare-create", policy, "prepare:rev-b:" + policy},
		{http.MethodPost, "/create", `{"box":{"id":"target"}}`, "create:target:target"},
		{http.MethodPost, "/create", `{"attempt":{"job_id":"job-1","claim_id":"claim-1"},"box":{"id":"target"}}`, ""},
		{http.MethodPost, "/cancel-create", `{"attempt_id":"attempt-1"}`, "cancel:target:attempt-1"},
		{http.MethodPost, "/cancel-create", `{"attempt_id":"attempt-1","job_id":"job-1","claim_id":"claim-1"}`, "cancel:target:attempt-1"},
		{http.MethodPost, "/replace-control", `{"operation":"reconcile"}`, `hosted:target:{"operation":"reconcile"}`},
		{http.MethodPost, "/rebuild", `{}`, "rebuild:target"},
		{http.MethodGet, "", "", "snapshot:target"},
		{http.MethodGet, "/status", "", "status:target"},
	} {
		for _, authorization := range []string{"", "Basic " + token, "Bearer wrong-token", "Bearer " + token} {
			req, err := http.NewRequestWithContext(t.Context(), route.method, base+path+route.suffix, strings.NewReader(route.body))
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Authorization", authorization)
			req.Header.Set("X-Boxlite-Outbound-Revision", "rev-b")
			response, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			body, err := io.ReadAll(response.Body)
			_ = response.Body.Close()
			if err != nil {
				t.Fatal(err)
			}
			if authorization != "Bearer "+token {
				if response.StatusCode != http.StatusUnauthorized {
					t.Fatalf("%s %q with %q: status=%d body=%s", route.method, route.suffix, authorization, response.StatusCode, body)
				}
				select {
				case call := <-backend.calls:
					t.Fatalf("denied %s %q reached backend: %s", route.method, route.suffix, call)
				default:
				}
				continue
			}
			if route.wantCall == "" {
				if response.StatusCode != http.StatusBadRequest {
					t.Fatalf("direct HTTP create with a V2 claim: status=%d body=%s", response.StatusCode, body)
				}
				select {
				case call := <-backend.calls:
					t.Fatalf("direct HTTP create with a V2 claim reached backend: %s", call)
				default:
				}
				continue
			}
			if response.StatusCode != http.StatusOK {
				t.Fatalf("allowed %s %q: status=%d body=%s", route.method, route.suffix, response.StatusCode, body)
			}
			select {
			case call := <-backend.calls:
				if call != route.wantCall {
					t.Fatalf("%s %q reached %q, want %q", route.method, route.suffix, call, route.wantCall)
				}
			default:
				t.Fatalf("allowed %s %q never reached backend", route.method, route.suffix)
			}
			if route.suffix == "" && response.Header.Get("ETag") != `"rev-b"` {
				t.Fatalf("snapshot ETag = %q", response.Header.Get("ETag"))
			}
		}
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
