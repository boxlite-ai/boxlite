/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

package sshcredential

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"golang.org/x/crypto/ssh"
)

func newTestClient(handler http.HandlerFunc) (*apiclient.APIClient, *httptest.Server) {
	server := httptest.NewServer(handler)
	cfg := apiclient.NewConfiguration()
	cfg.Servers = apiclient.ServerConfigurations{{URL: server.URL}}
	return apiclient.NewAPIClient(cfg), server
}

func TestCreateEphemeralCredential(t *testing.T) {
	var capturedBody map[string]any
	var capturedAppKeyHeader string
	var capturedPath string

	client, server := newTestClient(func(w http.ResponseWriter, r *http.Request) {
		capturedPath = r.URL.Path
		capturedAppKeyHeader = r.Header.Get("X-BoxLite-App-Key")
		if err := json.NewDecoder(r.Body).Decode(&capturedBody); err != nil {
			t.Fatalf("decode request body: %v", err)
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id":                   "cred-1",
			"grantId":              "grant-1",
			"boxId":                "box-1",
			"unixUser":             "root",
			"publicKeyFingerprint": "SHA256:abc",
			"expiresAt":            time.Now().Add(5 * time.Minute).Format(time.RFC3339),
			"endpoint":             "22-d-626f782d31.proxy.dev.boxlite.ai",
			"proxyCommand":         "proxytunnel -q -E -p proxy.dev.boxlite.ai:443 -d %h:%p",
			"hostKeyFingerprint":   "SHA256:host",
			"knownHostsEntry":      "22-d-626f782d31.proxy.dev.boxlite.ai ssh-ed25519 AAAA",
			"sshCommand":           "ssh root@22-d-626f782d31.proxy.dev.boxlite.ai",
		})
	})
	defer server.Close()

	credential, err := CreateEphemeralCredential(
		context.Background(),
		client,
		"box-1",
		"grant-1",
		5*time.Minute,
		WithAppKey("bag_svc_test-key"),
	)
	if err != nil {
		t.Fatalf("CreateEphemeralCredential: %v", err)
	}

	if !strings.Contains(capturedPath, "/box/box-1/ssh-access") {
		t.Errorf("expected request to /box/box-1/ssh-access, got %q", capturedPath)
	}
	if capturedAppKeyHeader != "bag_svc_test-key" {
		t.Errorf("expected X-BoxLite-App-Key header to be forwarded, got %q", capturedAppKeyHeader)
	}
	if capturedBody["grantId"] != "grant-1" {
		t.Errorf("expected grantId grant-1 in request body, got %v", capturedBody["grantId"])
	}
	if got, want := capturedBody["expiresInSeconds"], float64(300); got != want {
		t.Errorf("expected expiresInSeconds=%v, got %v", want, got)
	}

	// The request body must carry ONLY the public key -- never the private
	// material generated locally.
	publicKeyLine, _ := capturedBody["publicKey"].(string)
	if !strings.HasPrefix(publicKeyLine, "ssh-ed25519 ") {
		t.Fatalf("expected an ssh-ed25519 public key line in the request body, got %q", publicKeyLine)
	}
	if strings.Contains(publicKeyLine, "PRIVATE") {
		t.Fatalf("request body must never contain private key material")
	}

	// Round-trip proof via the real x/crypto/ssh parser: the private key
	// this function generated must parse as a valid signer whose public key
	// matches exactly what was submitted to the server.
	signer, err := ssh.ParsePrivateKey([]byte(credential.PrivateKeyPEM))
	if err != nil {
		t.Fatalf("ssh.ParsePrivateKey(credential.PrivateKeyPEM): %v", err)
	}
	derivedPublicKeyLine := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey())))
	submittedPublicKeyLine := strings.TrimSpace(strings.Join(strings.Fields(publicKeyLine)[:2], " "))
	if derivedPublicKeyLine != submittedPublicKeyLine {
		t.Fatalf(
			"private key does not correspond to the submitted public key:\n  derived:   %s\n  submitted: %s",
			derivedPublicKeyLine, submittedPublicKeyLine,
		)
	}

	if credential.Id != "cred-1" {
		t.Errorf("expected server response Id=cred-1, got %q", credential.Id)
	}
}

func TestCreateEphemeralCredential_GeneratesDistinctKeysPerCall(t *testing.T) {
	client, server := newTestClient(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id":                   "cred-x",
			"grantId":              "grant-1",
			"boxId":                "box-1",
			"unixUser":             "root",
			"publicKeyFingerprint": "SHA256:abc",
			"expiresAt":            time.Now().Add(time.Minute).Format(time.RFC3339),
			"endpoint":             "22-d-626f782d31.proxy.dev.boxlite.ai",
			"proxyCommand":         "proxytunnel -q -E -p proxy.dev.boxlite.ai:443 -d %h:%p",
			"hostKeyFingerprint":   "SHA256:host",
			"knownHostsEntry":      "22-d-626f782d31.proxy.dev.boxlite.ai ssh-ed25519 AAAA",
			"sshCommand":           "ssh root@22-d-626f782d31.proxy.dev.boxlite.ai",
		})
	})
	defer server.Close()

	first, err := CreateEphemeralCredential(context.Background(), client, "box-1", "grant-1", time.Minute)
	if err != nil {
		t.Fatalf("first call: %v", err)
	}
	second, err := CreateEphemeralCredential(context.Background(), client, "box-1", "grant-1", time.Minute)
	if err != nil {
		t.Fatalf("second call: %v", err)
	}

	if first.PrivateKeyPEM == second.PrivateKeyPEM {
		t.Fatalf("expected a fresh ephemeral keypair on every call")
	}
}

func TestCreateEphemeralCredential_ServerError(t *testing.T) {
	client, server := newTestClient(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]any{"error": "box not running"})
	})
	defer server.Close()

	_, err := CreateEphemeralCredential(context.Background(), client, "box-1", "grant-1", time.Minute)
	if err == nil {
		t.Fatal("expected an error when the server rejects the request")
	}
}
