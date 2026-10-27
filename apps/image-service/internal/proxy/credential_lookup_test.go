// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
)

func TestCredentialLookupHTTPContract(t *testing.T) {
	for _, tc := range []struct {
		name        string
		status      int
		body        string
		want        foundCredential
		unavailable bool
	}{
		{"login", 200, `{"kind":"basic","username":"bot","secretVersion":"version-1"}`, foundCredential{username: "bot", secretVersion: "version-1"}, false},
		{"none", 404, "", foundCredential{none: true}, false},
		{"forbidden", 403, "", foundCredential{forbidden: true}, false},
		{"unavailable", 503, "sensitive-response", foundCredential{}, true},
		{"malformed", 200, "sensitive-response", foundCredential{}, true},
		{"missing username", 200, `{"kind":"basic","secretVersion":"version-1"}`, foundCredential{}, true},
		{"missing secret", 200, `{"kind":"basic","username":"bot"}`, foundCredential{}, true},
		{"unknown kind", 200, `{"kind":"future","username":"bot","secretVersion":"version-1"}`, foundCredential{}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || r.URL.Path != "/api/runners/me/images/registry-credentials" {
					t.Errorf("lookup route = %s %s", r.Method, r.URL.Path)
				}
				if r.Header.Get("Authorization") != "Bearer runner-key" {
					t.Error("lookup did not carry the runner bearer token")
				}
				query := r.URL.Query()
				if query.Get("organizationId") != acmeOrg || query.Get("host") != "registry.example:5443" || query.Get("repository") != "team/a+b&c" {
					t.Errorf("lookup query = %v", query)
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.status)
				fmt.Fprint(w, tc.body)
			}))
			defer server.Close()
			config := apiclient.NewConfiguration()
			config.Servers = apiclient.ServerConfigurations{{URL: server.URL + "/api"}}
			config.HTTPClient = server.Client()
			finder := newCredentialFinder(apiclient.NewAPIClient(config), passwords{}, time.Minute)

			got, err := finder.ask(context.Background(), "runner-key", acmeOrg, "registry.example:5443", "team/a+b&c")
			if errors.Is(err, ErrCredentialUnavailable) != tc.unavailable || (!tc.unavailable && err != nil) {
				t.Fatalf("lookup error = %v; unavailable = %v", err, tc.unavailable)
			}
			if err != nil && strings.Contains(err.Error(), "sensitive-response") {
				t.Fatal("lookup error exposed the response body")
			}
			if got != tc.want {
				t.Errorf("lookup = %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestCredentialLookupHonorsCancellation(t *testing.T) {
	var requests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()
	config := apiclient.NewConfiguration()
	config.Servers = apiclient.ServerConfigurations{{URL: server.URL}}
	finder := newCredentialFinder(apiclient.NewAPIClient(config), passwords{}, time.Minute)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := finder.ask(ctx, "runner-key", acmeOrg, "ghcr.io", "team/app")
	if !errors.Is(err, context.Canceled) || !errors.Is(err, ErrCredentialUnavailable) {
		t.Fatalf("canceled lookup = %v", err)
	}
	if requests.Load() != 0 {
		t.Fatal("canceled lookup reached the server")
	}
}
