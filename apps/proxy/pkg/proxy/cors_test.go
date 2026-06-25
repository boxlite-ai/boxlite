// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func init() { gin.SetMode(gin.TestMode) }

// runCORS sends a GET carrying the given Origin/Host through the production
// corsMiddleware and returns the reflected Access-Control-Allow-Origin header.
func runCORS(t *testing.T, origin, host string, cookieDomain *string, allowlist []string) (string, string) {
	t.Helper()
	r := gin.New()
	r.Use(corsMiddleware(allowlist, cookieDomain))
	r.GET("/x", func(c *gin.Context) { c.Status(http.StatusOK) })

	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Host = host
	req.Header.Set("Origin", origin)
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)
	return rr.Header().Get("Access-Control-Allow-Origin"), rr.Header().Get("Access-Control-Allow-Credentials")
}

func strptr(s string) *string { return &s }

// TestCORSMiddleware_RejectsUntrustedOrigin is the security regression: an
// attacker origin must NOT be reflected with credentials. Before the fix the
// middleware reflected every origin alongside Access-Control-Allow-Credentials,
// so evil.com could read a victim's authenticated box/toolbox responses.
func TestCORSMiddleware_RejectsUntrustedOrigin(t *testing.T) {
	cookieDomain := strptr(".example.com")

	acao, _ := runCORS(t, "https://evil.com", "box.example.com", cookieDomain, nil)
	if acao == "https://evil.com" || acao == "*" {
		t.Errorf("untrusted origin reflected: Access-Control-Allow-Origin = %q, want empty", acao)
	}
}

// TestCORSMiddleware_AllowsTrustedOrigins verifies legitimate cross-origin
// access still works: a sibling subdomain under the cookie domain and an
// explicitly allowlisted origin are reflected with credentials. (Same-origin
// requests need no CORS header and are short-circuited by the CORS library.)
func TestCORSMiddleware_AllowsTrustedOrigins(t *testing.T) {
	cookieDomain := strptr(".example.com")

	cases := []struct {
		name      string
		origin    string
		host      string
		allowlist []string
	}{
		{"sibling subdomain", "https://app.example.com", "box.example.com", nil},
		{"allowlisted other domain", "https://dashboard.acme.io", "box.example.com", []string{"https://dashboard.acme.io"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			acao, acac := runCORS(t, tc.origin, tc.host, cookieDomain, tc.allowlist)
			if acao != tc.origin {
				t.Errorf("trusted origin not reflected: Access-Control-Allow-Origin = %q, want %q", acao, tc.origin)
			}
			if acac != "true" {
				t.Errorf("Access-Control-Allow-Credentials = %q, want \"true\"", acac)
			}
		})
	}
}
