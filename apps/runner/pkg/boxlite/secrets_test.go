// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BoxLite AI (originally Daytona Platforms Inc.
// Modified and rebranded for BoxLite

package boxlite

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/boxlite-ai/runner/pkg/api/dto"
)

func TestUpdateGvproxySecretsSendsRedactedShapeToUnixSocket(t *testing.T) {
	dir, err := os.MkdirTemp("/tmp", "gvp-secret-test-")
	if err != nil {
		t.Fatalf("mkdir temp: %v", err)
	}
	defer os.RemoveAll(dir)

	socketPath := filepath.Join(dir, "admin.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatalf("listen unix socket: %v", err)
	}
	defer listener.Close()

	got := make(chan gvproxyUpdateSecretsRequest, 1)
	server := &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPut {
				t.Fatalf("method = %s, want PUT", r.Method)
			}
			if r.URL.Path != "/services/secrets" {
				t.Fatalf("path = %s, want /services/secrets", r.URL.Path)
			}
			var req gvproxyUpdateSecretsRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Fatalf("decode request: %v", err)
			}
			got <- req
			w.WriteHeader(http.StatusNoContent)
		}),
	}
	go func() {
		_ = server.Serve(listener)
	}()
	defer server.Close()

	err = updateGvproxySecrets(context.Background(), socketPath, []dto.SecretDTO{{
		Name:        "openai",
		Value:       "sk-test",
		Hosts:       []string{"api.openai.com"},
		Placeholder: "<BOXLITE_SECRET:openai>",
	}})
	if err != nil {
		t.Fatalf("updateGvproxySecrets: %v", err)
	}

	req := <-got
	if len(req.Secrets) != 1 {
		t.Fatalf("secrets = %d, want 1", len(req.Secrets))
	}
	if req.Secrets[0].Name != "openai" || req.Secrets[0].Value != "sk-test" {
		t.Fatalf("unexpected secret payload: %#v", req.Secrets[0])
	}
}

func TestGvproxyAdminSocketPathUsesInternalBoxID(t *testing.T) {
	client := &Client{homeDir: "/tmp/boxlite-home"}
	got := client.gvproxyAdminSocketPath("internal-id")
	want := filepath.Join("/tmp/boxlite-home", "boxes", "internal-id", "sockets", "gvproxy-admin.sock")
	if got != want {
		t.Fatalf("socket path = %q, want %q", got, want)
	}
}

func TestBoxliteSecretsPreserveSecretSubstitutionRules(t *testing.T) {
	secrets := boxliteSecrets([]dto.SecretDTO{
		{
			Name:        "openai_api_key",
			Value:       "sk-test",
			Hosts:       []string{"api.openai.com"},
			Placeholder: "<BOXLITE_SECRET:openai_api_key>",
		},
	})

	if len(secrets) != 1 {
		t.Fatalf("expected one secret, got %d", len(secrets))
	}
	got := secrets[0]
	if got.Name != "openai_api_key" {
		t.Fatalf("name = %q, want openai_api_key", got.Name)
	}
	if got.Value != "sk-test" {
		t.Fatalf("value = %q, want sk-test", got.Value)
	}
	if got.Placeholder != "<BOXLITE_SECRET:openai_api_key>" {
		t.Fatalf("placeholder = %q", got.Placeholder)
	}
	if len(got.Hosts) != 1 || got.Hosts[0] != "api.openai.com" {
		t.Fatalf("hosts = %#v", got.Hosts)
	}
}
