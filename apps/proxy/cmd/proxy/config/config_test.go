// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package config

import (
	"encoding/json"
	"maps"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
)

func TestProxyStartupRequiresNamespace(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(apiclient.NewBoxliteConfiguration(
			"test", *apiclient.NewOidcConfig("https://issuer.example/", "test", "boxlite"),
			false, map[string]apiclient.Announcement{}, "", "", "", false, "test",
		))
	}))
	defer api.Close()
	for _, tc := range []struct {
		name, namespace string
		wantError       bool
	}{
		{"cloud", "proxy.boxlite.test", false},
		{"local", "localhost:4000", false},
		{"missing namespace", "", true},
		{"blank namespace", " \t", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			config = nil
			t.Cleanup(func() { config = nil })
			t.Setenv("PROXY_PORT", "4000")
			t.Setenv("PROXY_PROTOCOL", "http")
			t.Setenv("PROXY_API_KEY", "test-proxy-key")
			t.Setenv("BOXLITE_API_URL", api.URL)
			t.Setenv("PROXY_DOMAIN", tc.namespace)
			got, err := GetConfig()
			if tc.wantError {
				if err == nil || !strings.Contains(err.Error(), "PROXY_DOMAIN") {
					t.Fatalf("startup must reject an absent generated-host namespace: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got.ProxyDomain != tc.namespace {
				t.Fatalf("startup namespace=%q; want %q", got.ProxyDomain, tc.namespace)
			}
		})
	}
}

func TestGetOtelHeaders(t *testing.T) {
	cases := []struct {
		name    string
		headers string
		want    map[string]string
	}{
		{"empty", "", map[string]string{}},
		{"single pair", "authorization=Bearer abc", map[string]string{"authorization": "Bearer abc"}},
		{"multiple pairs", "a=1,b=2", map[string]string{"a": "1", "b": "2"}},
		{"whitespace trimmed", " a = 1 , b = 2 ", map[string]string{"a": "1", "b": "2"}},
		{"malformed pair skipped", "a=1,broken,b=2", map[string]string{"a": "1", "b": "2"}},
		{"value keeps extra equals", "a=x=y", map[string]string{"a": "x=y"}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := &Config{OtelHeaders: tc.headers}
			got := c.GetOtelHeaders()
			if !maps.Equal(got, tc.want) {
				t.Errorf("GetOtelHeaders(%q) = %v, want %v", tc.headers, got, tc.want)
			}
		})
	}
}
