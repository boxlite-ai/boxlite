// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package api

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/boxlite-ai/runner/internal"
	"github.com/google/uuid"
)

func TestProtectedListenerAuthenticatesV2(t *testing.T) {
	const apiName, runnerName, token = "api.example.test", "runner.example.test", "fixture-token"
	root, rootKey := issueListenerCertificate(t, "", 0, nil, nil)
	server, serverKey := issueListenerCertificate(t, runnerName, x509.ExtKeyUsageServerAuth, root, rootKey)
	config := ProtectedListenerConfig{
		Address:       "127.0.0.1:0",
		CertFile:      writeListenerPEM(t, "CERTIFICATE", server.Raw),
		KeyFile:       writeListenerPEM(t, "PRIVATE KEY", listenerPrivateKey(t, serverKey)),
		ClientCAFile:  writeListenerPEM(t, "CERTIFICATE", root.Raw),
		ClientDNSName: apiName,
	}
	boot := ProtectedBootConfig{
		RunnerID: "8137cc0d-5d3f-43b8-aa32-b9304740269e",
		DoHURL:   "https://resolver.example.test/dns-query", DoHAddress: "1.1.1.1:443",
	}
	address, stop, err := StartProtectedListener(t.Context(), slog.Default(), config, boot, token)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(stop)
	roots := x509.NewCertPool()
	roots.AddCert(root)
	api, apiKey := issueListenerCertificate(t, apiName, x509.ExtKeyUsageClientAuth, root, rootKey)
	peer, peerKey := issueListenerCertificate(t, "peer.example.test", x509.ExtKeyUsageClientAuth, root, rootKey)
	otherRoot, otherKey := issueListenerCertificate(t, "", 0, nil, nil)
	untrusted, untrustedKey := issueListenerCertificate(t, apiName, x509.ExtKeyUsageClientAuth, otherRoot, otherKey)
	url := "https://" + address.String()
	for _, tc := range []struct {
		name, path, bearer, runnerID string
		certificate                  *x509.Certificate
		key                          *ecdsa.PrivateKey
		status                       int
	}{
		{"API capability", "/v1/outbound-proxy/bootstrap", token, boot.RunnerID, api, apiKey, http.StatusOK},
		{"no client certificate", "/v1/outbound-proxy/bootstrap", token, boot.RunnerID, nil, nil, 0},
		{"wrong client SAN", "/v1/outbound-proxy/bootstrap", token, boot.RunnerID, peer, peerKey, 0},
		{"untrusted client", "/v1/outbound-proxy/bootstrap", token, boot.RunnerID, untrusted, untrustedKey, 0},
		{"wrong token", "/v1/outbound-proxy/bootstrap", "other-token", boot.RunnerID, api, apiKey, http.StatusUnauthorized},
		{"wrong Runner ID", "/v1/outbound-proxy/bootstrap", token, uuid.NewString(), api, apiKey, http.StatusForbidden},
		{"ordinary route", "/info", token, boot.RunnerID, api, apiKey, http.StatusNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			credentials := &tls.Config{RootCAs: roots, ServerName: runnerName, MinVersion: tls.VersionTLS12}
			if tc.certificate != nil {
				credentials.GetClientCertificate = func(*tls.CertificateRequestInfo) (*tls.Certificate, error) {
					return &tls.Certificate{Certificate: [][]byte{tc.certificate.Raw}, PrivateKey: tc.key}, nil
				}
			}
			transport := &http.Transport{TLSClientConfig: credentials}
			t.Cleanup(transport.CloseIdleConnections)
			client := &http.Client{Transport: transport, Timeout: 5 * time.Second}
			request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, url+tc.path, nil)
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Authorization", "Bearer "+tc.bearer)
			request.Header.Set("X-BoxLite-Runner-Id", tc.runnerID)
			response, err := client.Do(request)
			if err != nil {
				if tc.status == 0 {
					return
				}
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != tc.status {
				t.Fatalf("HTTP status %d, want %d (zero means handshake refused)", response.StatusCode, tc.status)
			}
			if tc.status == http.StatusOK {
				var capability struct {
					RunnerID       string   `json:"runner_id"`
					Version        int      `json:"version"`
					ProcessID      string   `json:"process_id"`
					BinaryIdentity string   `json:"binary_identity"`
					Operations     []string `json:"operations"`
				}
				if err := json.NewDecoder(response.Body).Decode(&capability); err != nil {
					t.Fatal(err)
				}
				if capability.RunnerID != boot.RunnerID || capability.Version != 2 || uuid.Validate(capability.ProcessID) != nil ||
					capability.BinaryIdentity != internal.Version || capability.Operations == nil || len(capability.Operations) != 0 {
					t.Fatalf("unexpected capability: %+v", capability)
				}
			}
		})
	}

	config.Address = address.String()
	if _, stopDuplicate, err := StartProtectedListener(t.Context(), slog.Default(), config, boot, token); err == nil {
		stopDuplicate()
		t.Fatal("a second protected listener bound the same address")
	}
	stop()
	_, stopReplacement, err := StartProtectedListener(context.Background(), slog.Default(), config, boot, token)
	if err != nil {
		t.Fatalf("listener did not release its socket on shutdown: %v", err)
	}
	stopReplacement()
}

func issueListenerCertificate(t *testing.T, dnsName string, usage x509.ExtKeyUsage, parent *x509.Certificate, signer *ecdsa.PrivateKey) (*x509.Certificate, *ecdsa.PrivateKey) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	certificate := &x509.Certificate{
		NotBefore: now.Add(-time.Minute),
		NotAfter:  now.Add(time.Hour),
		KeyUsage:  x509.KeyUsageDigitalSignature,
	}
	if parent == nil {
		certificate.BasicConstraintsValid = true
		certificate.IsCA = true
		certificate.KeyUsage |= x509.KeyUsageCertSign
		parent, signer = certificate, key
	} else {
		certificate.DNSNames = []string{dnsName}
		certificate.ExtKeyUsage = []x509.ExtKeyUsage{usage}
	}
	der, err := x509.CreateCertificate(rand.Reader, certificate, parent, &key.PublicKey, signer)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return parsed, key
}

func listenerPrivateKey(t *testing.T, key *ecdsa.PrivateKey) []byte {
	t.Helper()
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return der
}

func writeListenerPEM(t *testing.T, kind string, der []byte) string {
	t.Helper()
	file := filepath.Join(t.TempDir(), "cert.pem")
	if err := os.WriteFile(file, pem.EncodeToMemory(&pem.Block{Type: kind, Bytes: der}), 0600); err != nil {
		t.Fatal(err)
	}
	return file
}
