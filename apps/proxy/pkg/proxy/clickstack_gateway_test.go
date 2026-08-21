// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/coreos/go-oidc/v3/oidc"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

type tokenVerifierFunc func(string) error

func (function tokenVerifierFunc) Verify(_ context.Context, token string) error {
	return function(token)
}

func testClickStackGatewayConfig() ClickStackGatewayConfig {
	return ClickStackGatewayConfig{
		UpstreamURL:      "http://clickhouse.internal:8123",
		Username:         "otel_reader",
		Password:         "reader-password",
		OIDCIssuer:       "https://employees.example.com/",
		OIDCAudience:     "https://backoffice.example.com",
		OIDCRoleClaim:    "https://boxlite.ai/roles",
		OIDCAllowedRoles: []string{"backoffice-operator", "backoffice-admin"},
	}
}

func TestClickStackGatewayInjectsReaderCredentials(t *testing.T) {
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if got := request.URL.Query().Get("query"); got != "SELECT 1" {
			t.Fatalf("unexpected query: %q", got)
		}
		for _, key := range []string{"user", "password"} {
			if request.URL.Query().Has(key) {
				t.Fatalf("credential query parameter %q reached ClickHouse", key)
			}
		}
		if got := request.Header.Get("X-ClickHouse-User"); got != "otel_reader" {
			t.Fatalf("unexpected ClickHouse user: %q", got)
		}
		if got := request.Header.Get("X-ClickHouse-Key"); got != "reader-password" {
			t.Fatalf("unexpected ClickHouse password: %q", got)
		}
		for _, key := range []string{"Authorization", "Cookie", "X-Amzn-Oidc-Accesstoken", "X-Amzn-Oidc-Data", "X-Amzn-Oidc-Identity"} {
			if request.Header.Get(key) != "" {
				t.Fatalf("sensitive header %q reached ClickHouse", key)
			}
		}
		return &http.Response{
			StatusCode: http.StatusNoContent,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader("")),
		}, nil
	})

	handler, err := newClickStackGatewayHandler(testClickStackGatewayConfig(), transport, tokenVerifierFunc(func(token string) error {
		if token != "employee-token" {
			t.Fatalf("unexpected employee token: %q", token)
		}
		return nil
	}))
	if err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodPost, "/?query=SELECT+1&user=admin&password=admin-password", nil)
	request.SetBasicAuth("admin", "admin-password")
	request.Header.Set("Cookie", "BoxLiteClickStackSession=employee-session")
	request.Header.Set("X-ClickHouse-User", "admin")
	request.Header.Set("X-ClickHouse-Key", "admin-password")
	request.Header.Set("X-Amzn-Oidc-Data", "claims")
	request.Header.Set("X-Amzn-Oidc-Identity", "employee")
	request.Header.Set("X-Amzn-Oidc-Accesstoken", "employee-token")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusNoContent {
		t.Fatalf("unexpected status: %d", response.Code)
	}
}

func TestClickStackGatewayHealthDoesNotReachClickHouse(t *testing.T) {
	upstreamCalls := 0
	transport := roundTripFunc(func(*http.Request) (*http.Response, error) {
		upstreamCalls++
		return nil, nil
	})

	handler, err := newClickStackGatewayHandler(testClickStackGatewayConfig(), transport, tokenVerifierFunc(func(string) error {
		return nil
	}))
	if err != nil {
		t.Fatal(err)
	}

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/health", nil))

	if response.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d", response.Code)
	}
	if upstreamCalls != 0 {
		t.Fatalf("health request reached ClickHouse %d times", upstreamCalls)
	}
}

func TestClickStackGatewayRejectsUnsafeConfiguration(t *testing.T) {
	for name, config := range map[string]ClickStackGatewayConfig{
		"missing upstream": {},
		"unsafe scheme":    {UpstreamURL: "file:///etc/passwd"},
		"upstream creds":   {UpstreamURL: "https://admin:secret@example.com"},
		"missing username": {Username: ""},
		"missing password": {Password: ""},
		"unsafe issuer":    {OIDCIssuer: "http://employees.example.com"},
		"missing audience": {OIDCAudience: ""},
		"missing claim":    {OIDCRoleClaim: ""},
		"missing roles":    {OIDCAllowedRoles: nil},
	} {
		t.Run(name, func(t *testing.T) {
			candidate := testClickStackGatewayConfig()
			switch name {
			case "missing upstream":
				candidate.UpstreamURL = ""
			case "unsafe scheme", "upstream creds":
				candidate.UpstreamURL = config.UpstreamURL
			case "missing username":
				candidate.Username = ""
			case "missing password":
				candidate.Password = ""
			case "unsafe issuer":
				candidate.OIDCIssuer = config.OIDCIssuer
			case "missing audience":
				candidate.OIDCAudience = ""
			case "missing claim":
				candidate.OIDCRoleClaim = ""
			case "missing roles":
				candidate.OIDCAllowedRoles = nil
			}
			if _, err := validateClickStackGatewayConfig(candidate); err == nil {
				t.Fatal("expected configuration error")
			}
		})
	}
}

func TestClickStackGatewayRequiresAuthorizedEmployee(t *testing.T) {
	upstreamCalls := 0
	transport := roundTripFunc(func(*http.Request) (*http.Response, error) {
		upstreamCalls++
		return nil, nil
	})
	handler, err := newClickStackGatewayHandler(testClickStackGatewayConfig(), transport, tokenVerifierFunc(func(string) error {
		return errors.New("role not allowed")
	}))
	if err != nil {
		t.Fatal(err)
	}

	for name, expectation := range map[string]struct {
		token  string
		status int
	}{
		"missing token": {status: http.StatusUnauthorized},
		"wrong role":    {token: "support-token", status: http.StatusForbidden},
	} {
		t.Run(name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/clickstack", nil)
			if expectation.token != "" {
				request.Header.Set("X-Amzn-Oidc-Accesstoken", expectation.token)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != expectation.status {
				t.Fatalf("unexpected status: %d", response.Code)
			}
		})
	}
	if upstreamCalls != 0 {
		t.Fatalf("unauthorized request reached ClickHouse %d times", upstreamCalls)
	}
}

func TestClickStackGatewayAuthorizesOnlyConfiguredBackofficeRoles(t *testing.T) {
	claim := "https://boxlite.ai/roles"
	allowed := map[string]struct{}{
		"backoffice-operator": {},
		"backoffice-admin":    {},
	}
	for name, claims := range map[string]map[string]any{
		"operator": {"scope": "openid boxlite-backoffice", claim: []any{"backoffice-operator"}},
		"admin":    {"scp": []any{"openid", "boxlite-backoffice"}, claim: "backoffice-admin"},
	} {
		t.Run(name, func(t *testing.T) {
			if err := authorizeClickStackClaims(claims, claim, allowed); err != nil {
				t.Fatal(err)
			}
		})
	}
	for name, claims := range map[string]map[string]any{
		"support":       {"scope": "openid boxlite-backoffice", claim: []any{"backoffice-support"}},
		"finance":       {"scope": "openid boxlite-backoffice", claim: []any{"backoffice-finance"}},
		"missing scope": {claim: []any{"backoffice-admin"}},
		"missing role":  {"scope": "openid boxlite-backoffice"},
	} {
		t.Run(name, func(t *testing.T) {
			if err := authorizeClickStackClaims(claims, claim, allowed); err == nil {
				t.Fatal("expected authorization failure")
			}
		})
	}
}

func TestClickStackGatewayPreservesOIDCIssuer(t *testing.T) {
	var server *httptest.Server
	server = httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/.well-known/openid-configuration" {
			http.NotFound(writer, request)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(writer, `{
			"issuer": %q,
			"authorization_endpoint": %q,
			"token_endpoint": %q,
			"jwks_uri": %q,
			"userinfo_endpoint": %q,
			"id_token_signing_alg_values_supported": ["RS256"]
		}`, server.URL+"/", server.URL+"/authorize", server.URL+"/oauth/token", server.URL+"/jwks", server.URL+"/userinfo")
	}))
	defer server.Close()

	config := testClickStackGatewayConfig()
	config.OIDCIssuer = server.URL + "/"
	ctx := oidc.ClientContext(context.Background(), server.Client())

	if _, err := newOIDCClickStackTokenVerifier(ctx, config); err != nil {
		t.Fatal(err)
	}
}
