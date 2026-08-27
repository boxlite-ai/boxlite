// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

type grantRedeemerFunc func(context.Context, string) error

func (function grantRedeemerFunc) Redeem(ctx context.Context, code string) (clickStackSessionBinding, error) {
	err := function(ctx, code)
	return clickStackSessionBinding{
		ID:        strings.Repeat("s", 43),
		ExpiresAt: time.Now().Add(30 * time.Minute).Truncate(time.Second),
	}, err
}

func (function grantRedeemerFunc) Introspect(context.Context, string) (bool, error) {
	return true, nil
}

func testClickStackSessionKeys() string {
	key := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{1}, 32))
	return fmt.Sprintf(`{"current":%q}`, key)
}

func testClickStackRedeemToken() string {
	return base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{3}, 32))
}

func testClickStackGatewayConfig() ClickStackGatewayConfig {
	return ClickStackGatewayConfig{
		UpstreamURL:             "http://clickhouse.internal:8123",
		Username:                "otel_reader",
		Password:                "reader-password",
		BackofficeRedeemURL:     "https://backoffice.example.test/api/backoffice/v1/observability/clickstack/redeem",
		BackofficeIntrospectURL: "https://backoffice.example.test/api/backoffice/v1/observability/clickstack/introspect",
		BackofficeEntryURL:      "https://backoffice.example.test/platform/observability",
		RedeemToken:             testClickStackRedeemToken(),
		SessionKeys:             testClickStackSessionKeys(),
	}
}

func TestClickStackGatewayExchangesOneTimeHandoffForReaderSession(t *testing.T) {
	upstreamCalls := 0
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		upstreamCalls++
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
		return &http.Response{StatusCode: http.StatusNoContent, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(""))}, nil
	})

	code := strings.Repeat("a", 43)
	redeemCalls := 0
	handler, err := newClickStackGatewayHandler(testClickStackGatewayConfig(), transport, grantRedeemerFunc(func(_ context.Context, got string) error {
		redeemCalls++
		if got != code {
			t.Fatalf("unexpected handoff code")
		}
		return nil
	}))
	if err != nil {
		t.Fatal(err)
	}

	form := url.Values{"code": {code}}
	handoff := httptest.NewRequest(http.MethodPost, "/auth/backoffice", strings.NewReader(form.Encode()))
	handoff.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	handoff.Header.Set("Origin", "https://backoffice.example.test")
	handoffResponse := httptest.NewRecorder()
	handler.ServeHTTP(handoffResponse, handoff)
	if handoffResponse.Code != http.StatusSeeOther || handoffResponse.Header().Get("Location") != "/clickstack" {
		t.Fatalf("unexpected handoff response: %d %q", handoffResponse.Code, handoffResponse.Header().Get("Location"))
	}
	if redeemCalls != 1 {
		t.Fatalf("handoff was redeemed %d times", redeemCalls)
	}
	cookies := handoffResponse.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || !cookies[0].Secure || cookies[0].SameSite != http.SameSiteLaxMode {
		t.Fatalf("unexpected gateway session cookie: %#v", cookies)
	}

	request := httptest.NewRequest(http.MethodPost, "/?query=SELECT+1&user=admin&password=admin-password", nil)
	request.AddCookie(cookies[0])
	request.SetBasicAuth("admin", "admin-password")
	request.Header.Set("X-ClickHouse-User", "admin")
	request.Header.Set("X-ClickHouse-Key", "admin-password")
	request.Header.Set("X-Amzn-Oidc-Data", "claims")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent || upstreamCalls != 1 {
		t.Fatalf("unexpected proxied response: status=%d calls=%d", response.Code, upstreamCalls)
	}
}

func TestClickStackGatewayRedeemsHandoffThroughBackoffice(t *testing.T) {
	code := strings.Repeat("a", 43)
	expiresAt := time.Now().Add(30 * time.Minute).Truncate(time.Second)
	redeemer := &httpClickStackBackofficeClient{
		redeemURL:     "https://backoffice.example.test/api/backoffice/v1/observability/clickstack/redeem",
		introspectURL: "https://backoffice.example.test/api/backoffice/v1/observability/clickstack/introspect",
		token:         testClickStackRedeemToken(),
		client: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			if request.Method != http.MethodPost || request.Header.Get("Content-Type") != "application/json" {
				t.Fatalf("unexpected redemption request")
			}
			if request.Header.Get("Authorization") != "Bearer "+testClickStackRedeemToken() {
				t.Fatalf("redemption request did not authenticate the gateway")
			}
			body, err := io.ReadAll(request.Body)
			if err != nil {
				t.Fatal(err)
			}
			if string(body) != fmt.Sprintf(`{"code":%q}`, code) {
				t.Fatalf("unexpected redemption body")
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{"Content-Type": {"application/json"}},
				Body: io.NopCloser(strings.NewReader(fmt.Sprintf(
					`{"active":true,"sessionId":%q,"expiresAt":%q}`,
					strings.Repeat("s", 43),
					expiresAt.Format(time.RFC3339),
				))),
			}, nil
		})},
	}
	binding, err := redeemer.Redeem(context.Background(), code)
	if err != nil {
		t.Fatal(err)
	}
	if binding.ID != strings.Repeat("s", 43) || !binding.ExpiresAt.Equal(expiresAt) {
		t.Fatalf("unexpected Backoffice binding: %#v", binding)
	}
}

func TestClickStackGatewayRedirectsRequestsWithoutSession(t *testing.T) {
	upstreamCalls := 0
	handler, err := newClickStackGatewayHandler(
		testClickStackGatewayConfig(),
		roundTripFunc(func(*http.Request) (*http.Response, error) { upstreamCalls++; return nil, nil }),
		grantRedeemerFunc(func(context.Context, string) error { return nil }),
	)
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/clickstack", nil))
	if response.Code != http.StatusSeeOther || response.Header().Get("Location") != "https://backoffice.example.test/platform/observability" {
		t.Fatalf("unexpected redirect: %d %q", response.Code, response.Header().Get("Location"))
	}
	if upstreamCalls != 0 {
		t.Fatalf("unauthenticated request reached ClickHouse")
	}
}

func TestClickStackGatewayRejectsInvalidHandoffWithoutRedeeming(t *testing.T) {
	redeemCalls := 0
	handler, err := newClickStackGatewayHandler(
		testClickStackGatewayConfig(),
		roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, nil }),
		grantRedeemerFunc(func(context.Context, string) error { redeemCalls++; return nil }),
	)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/auth/backoffice", strings.NewReader("code=short"))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Origin", "https://backoffice.example.test")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || redeemCalls != 0 {
		t.Fatalf("unexpected invalid handoff result: status=%d calls=%d", response.Code, redeemCalls)
	}

	wrongOrigin := httptest.NewRequest(
		http.MethodPost,
		"/auth/backoffice",
		strings.NewReader("code="+strings.Repeat("a", 43)),
	)
	wrongOrigin.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	wrongOrigin.Header.Set("Origin", "https://attacker.example.test")
	wrongOriginResponse := httptest.NewRecorder()
	handler.ServeHTTP(wrongOriginResponse, wrongOrigin)
	if wrongOriginResponse.Code != http.StatusBadRequest || redeemCalls != 0 {
		t.Fatalf("unexpected wrong-origin result: status=%d calls=%d", wrongOriginResponse.Code, redeemCalls)
	}
}

func TestClickStackGatewaySessionRejectsTamperingAndExpiry(t *testing.T) {
	now := time.Date(2026, 8, 26, 10, 0, 0, 0, time.UTC)
	sessions, err := newClickStackSessionManager(testClickStackSessionKeys(), func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	binding := clickStackSessionBinding{ID: strings.Repeat("s", 43), ExpiresAt: now.Add(30 * time.Minute)}
	cookie, err := sessions.Issue(binding)
	if err != nil {
		t.Fatal(err)
	}
	if verified, ok := sessions.Verify(cookie.Value); !ok || verified != binding {
		t.Fatal("fresh session was rejected")
	}
	if _, ok := sessions.Verify(cookie.Value + "x"); ok {
		t.Fatal("tampered session was accepted")
	}
	now = binding.ExpiresAt.Add(time.Second)
	if _, ok := sessions.Verify(cookie.Value); ok {
		t.Fatal("expired session was accepted")
	}
}

func TestClickStackGatewaySessionKeysRemainCompatibleDuringThreePhaseRotation(t *testing.T) {
	now := time.Date(2026, 8, 26, 10, 0, 0, 0, time.UTC)
	oldKey := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{1}, 32))
	newKey := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{2}, 32))
	oldSessions, err := newClickStackSessionManager(fmt.Sprintf(`{"current":%q}`, oldKey), func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	oldBinding := clickStackSessionBinding{ID: strings.Repeat("o", 43), ExpiresAt: now.Add(30 * time.Minute)}
	oldCookie, err := oldSessions.Issue(oldBinding)
	if err != nil {
		t.Fatal(err)
	}

	stagedSessions, err := newClickStackSessionManager(
		fmt.Sprintf(`{"current":%q,"previous":%q}`, oldKey, newKey),
		func() time.Time { return now },
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := stagedSessions.Verify(oldCookie.Value); !ok {
		t.Fatal("phase-one tasks rejected an old session")
	}

	rotatingSessions, err := newClickStackSessionManager(
		fmt.Sprintf(`{"current":%q,"previous":%q}`, newKey, oldKey),
		func() time.Time { return now },
	)
	if err != nil {
		t.Fatal(err)
	}
	newBinding := clickStackSessionBinding{ID: strings.Repeat("n", 43), ExpiresAt: now.Add(30 * time.Minute)}
	newCookie, err := rotatingSessions.Issue(newBinding)
	if err != nil {
		t.Fatal(err)
	}
	_, rotatingAcceptsOld := rotatingSessions.Verify(oldCookie.Value)
	_, stagedAcceptsNew := stagedSessions.Verify(newCookie.Value)
	if !rotatingAcceptsOld || !stagedAcceptsNew {
		t.Fatal("phase-one and phase-two tasks did not accept each other's sessions")
	}

	newSessions, err := newClickStackSessionManager(fmt.Sprintf(`{"current":%q}`, newKey), func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := newSessions.Verify(oldCookie.Value); ok {
		t.Fatal("session signed by removed key was accepted")
	}
	if _, ok := newSessions.Verify(newCookie.Value); !ok {
		t.Fatal("session signed by the retained key was rejected")
	}
}

func TestClickStackGatewayRedeemTokenSelectsCurrentKeyDuringThreePhaseRotation(t *testing.T) {
	oldKey := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{3}, 32))
	newKey := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{4}, 32))

	for _, test := range []struct {
		encoded string
		want    string
	}{
		{encoded: fmt.Sprintf(`{"current":%q,"previous":%q}`, oldKey, newKey), want: oldKey},
		{encoded: fmt.Sprintf(`{"current":%q,"previous":%q}`, newKey, oldKey), want: newKey},
		{encoded: fmt.Sprintf(`{"current":%q}`, newKey), want: newKey},
	} {
		got, err := currentClickStackRedeemToken(test.encoded)
		if err != nil {
			t.Fatal(err)
		}
		if got != test.want {
			t.Fatalf("unexpected current redeem token")
		}
	}
}

func TestClickStackGatewayBoundsHandoffRateAndConcurrency(t *testing.T) {
	now := time.Date(2026, 8, 26, 10, 0, 0, 0, time.UTC)
	limiter := newClickStackHandoffLimiter(func() time.Time { return now })
	for range clickStackHandoffMaxInFlight {
		if !limiter.Acquire() {
			t.Fatal("request within the concurrency limit was rejected")
		}
	}
	if limiter.Acquire() {
		t.Fatal("request above the concurrency limit was accepted")
	}
	for range clickStackHandoffMaxInFlight {
		limiter.Release()
	}
	for range clickStackHandoffRateLimit - clickStackHandoffMaxInFlight {
		if !limiter.Acquire() {
			t.Fatal("request within the rate limit was rejected")
		}
		limiter.Release()
	}
	if limiter.Acquire() {
		t.Fatal("request above the rate limit was accepted")
	}
	now = now.Add(time.Second)
	if !limiter.Acquire() {
		t.Fatal("rate limit did not reset after its window")
	}
	limiter.Release()
}

func TestClickStackGatewayReadinessChecksClickHouseAndEmbeddedUI(t *testing.T) {
	upstreamCalls := 0
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		upstreamCalls++
		header := make(http.Header)
		body := "1\n"
		switch upstreamCalls {
		case 1:
			if request.URL.Query().Get("query") != "SELECT 1 FROM otel.otel_logs LIMIT 1" {
				t.Fatalf("unexpected readiness query")
			}
		case 2:
			header.Set("Content-Type", "text/html; charset=utf-8")
			body = `<!doctype html><title>ClickStack</title><script id="__NEXT_DATA__">{"assetPrefix":"/clickstack"}</script>`
		case 3:
			header.Set("Content-Type", "application/javascript")
			body = `window.__ENV={"NEXT_PUBLIC_IS_LOCAL_MODE":"true"}`
		}
		return &http.Response{StatusCode: http.StatusOK, Header: header, Body: io.NopCloser(strings.NewReader(body))}, nil
	})
	handler, err := newClickStackGatewayHandler(testClickStackGatewayConfig(), transport, grantRedeemerFunc(func(context.Context, string) error { return nil }))
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/ready", nil))
	if response.Code != http.StatusOK || upstreamCalls != 3 {
		t.Fatalf("unexpected readiness result: status=%d calls=%d", response.Code, upstreamCalls)
	}
}

func TestClickStackGatewayRejectsUnsafeConfiguration(t *testing.T) {
	for name, mutate := range map[string]func(*ClickStackGatewayConfig){
		"missing upstream": func(config *ClickStackGatewayConfig) { config.UpstreamURL = "" },
		"upstream creds": func(config *ClickStackGatewayConfig) {
			config.UpstreamURL = (&url.URL{
				Scheme: "https",
				Host:   "example.test",
				User:   url.UserPassword("admin", "synthetic-password"),
			}).String()
		},
		"missing username": func(config *ClickStackGatewayConfig) { config.Username = "" },
		"missing password": func(config *ClickStackGatewayConfig) { config.Password = "" },
		"missing redeem token": func(config *ClickStackGatewayConfig) {
			config.RedeemToken = ""
		},
		"unsafe redeem URL": func(config *ClickStackGatewayConfig) {
			config.BackofficeRedeemURL = "http://backoffice.example.test/redeem"
		},
		"unsafe introspect URL": func(config *ClickStackGatewayConfig) {
			config.BackofficeIntrospectURL = "https://other.example.test/introspect"
		},
		"unsafe entry URL": func(config *ClickStackGatewayConfig) {
			config.BackofficeEntryURL = (&url.URL{
				Scheme: "https",
				Host:   "backoffice.example.test",
				Path:   "/platform/observability",
				User:   url.UserPassword("user", "synthetic-password"),
			}).String()
		},
		"missing keys": func(config *ClickStackGatewayConfig) { config.SessionKeys = "" },
	} {
		t.Run(name, func(t *testing.T) {
			config := testClickStackGatewayConfig()
			mutate(&config)
			if _, err := validateClickStackGatewayConfig(config); err == nil {
				t.Fatal("expected configuration error")
			}
		})
	}
}
