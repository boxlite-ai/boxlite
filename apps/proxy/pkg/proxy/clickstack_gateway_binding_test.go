// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type sessionIntrospectorFunc func(context.Context, string) (bool, error)

func (function sessionIntrospectorFunc) Introspect(ctx context.Context, sessionID string) (bool, error) {
	return function(ctx, sessionID)
}

func testClickStackSessionBinding(now time.Time) clickStackSessionBinding {
	return clickStackSessionBinding{
		ID:        strings.Repeat("s", 43),
		ExpiresAt: now.Add(time.Hour),
	}
}

func TestClickStackGatewaySessionUsesBackofficeAbsoluteExpiry(t *testing.T) {
	now := time.Date(2026, 8, 26, 10, 0, 0, 0, time.UTC)
	sessions, err := newClickStackSessionManager(testClickStackSessionKeys(), func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	binding := testClickStackSessionBinding(now)
	cookie, err := sessions.Issue(binding)
	if err != nil {
		t.Fatal(err)
	}
	if cookie.Expires != binding.ExpiresAt || cookie.MaxAge != int(time.Hour.Seconds()) {
		t.Fatalf("gateway cookie did not inherit Backoffice expiry: %#v", cookie)
	}
	verified, ok := sessions.Verify(cookie.Value)
	if !ok || verified != binding {
		t.Fatalf("unexpected verified binding: %#v %t", verified, ok)
	}

	now = binding.ExpiresAt.Add(time.Second)
	if _, ok := sessions.Verify(cookie.Value); ok {
		t.Fatal("binding remained valid after the Backoffice session expiry")
	}
}

func TestClickStackGatewaySessionRejectsUnsafeBackofficeExpiry(t *testing.T) {
	now := time.Date(2026, 8, 26, 10, 0, 0, 0, time.UTC)
	sessions, err := newClickStackSessionManager(testClickStackSessionKeys(), func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	for name, expiresAt := range map[string]time.Time{
		"expired":      now.Add(-time.Second),
		"too short":    now.Add(500 * time.Millisecond),
		"too far away": now.Add(clickStackSessionMaximumTTL + clickStackSessionClockSkew + time.Second),
	} {
		t.Run(name, func(t *testing.T) {
			binding := testClickStackSessionBinding(now)
			binding.ExpiresAt = expiresAt
			if _, err := sessions.Issue(binding); err == nil {
				t.Fatal("unsafe Backoffice expiry was accepted")
			}
		})
	}
}

func TestClickStackSessionAuthorizerRevalidatesBoundedCache(t *testing.T) {
	now := time.Date(2026, 8, 26, 10, 0, 0, 0, time.UTC)
	binding := testClickStackSessionBinding(now)
	active := true
	calls := 0
	authorizer := newClickStackSessionAuthorizer(
		sessionIntrospectorFunc(func(_ context.Context, sessionID string) (bool, error) {
			calls++
			if sessionID != binding.ID {
				t.Fatalf("unexpected session id: %q", sessionID)
			}
			return active, nil
		}),
		func() time.Time { return now },
	)
	authorizer.Seed(binding)

	for _, advance := range []time.Duration{0, clickStackSessionValidationInterval - time.Second} {
		now = now.Add(advance)
		allowed, err := authorizer.Authorize(context.Background(), binding)
		if err != nil || !allowed {
			t.Fatalf("cached active session was rejected: allowed=%t err=%v", allowed, err)
		}
	}
	if calls != 0 {
		t.Fatalf("fresh cache unexpectedly introspected %d times", calls)
	}

	now = now.Add(2 * time.Second)
	allowed, err := authorizer.Authorize(context.Background(), binding)
	if err != nil || !allowed || calls != 1 {
		t.Fatalf("session was not periodically revalidated: allowed=%t calls=%d err=%v", allowed, calls, err)
	}

	active = false
	now = now.Add(clickStackSessionValidationInterval)
	allowed, err = authorizer.Authorize(context.Background(), binding)
	if err != nil || allowed || calls != 2 {
		t.Fatalf("revoked session was not rejected: allowed=%t calls=%d err=%v", allowed, calls, err)
	}

	for index := 0; index < clickStackSessionCacheMaxEntries+100; index++ {
		candidate := binding
		candidate.ID = fmt.Sprintf("%043d", index)
		authorizer.Seed(candidate)
	}
	if got := authorizer.CacheSize(); got > clickStackSessionCacheMaxEntries {
		t.Fatalf("session cache exceeded its bound: %d", got)
	}
}

func TestClickStackSessionAuthorizerCoalescesConcurrentIntrospection(t *testing.T) {
	now := time.Date(2026, 8, 26, 10, 0, 0, 0, time.UTC)
	binding := testClickStackSessionBinding(now)
	started := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int32
	authorizer := newClickStackSessionAuthorizer(
		sessionIntrospectorFunc(func(context.Context, string) (bool, error) {
			if calls.Add(1) == 1 {
				close(started)
			}
			<-release
			return true, nil
		}),
		func() time.Time { return now },
	)
	authorizer.Seed(binding)
	now = now.Add(clickStackSessionValidationInterval + time.Second)

	const workers = 8
	results := make(chan error, workers)
	var ready sync.WaitGroup
	ready.Add(workers)
	begin := make(chan struct{})
	for range workers {
		go func() {
			ready.Done()
			<-begin
			allowed, err := authorizer.Authorize(context.Background(), binding)
			if err == nil && !allowed {
				err = fmt.Errorf("active session was rejected")
			}
			results <- err
		}()
	}
	ready.Wait()
	close(begin)
	<-started
	close(release)
	for range workers {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("concurrent requests performed %d introspections", got)
	}
}

func TestClickStackSessionMiddlewareRevalidatesBeforeProxying(t *testing.T) {
	now := time.Date(2026, 8, 26, 10, 0, 0, 0, time.UTC)
	binding := testClickStackSessionBinding(now)
	active := true
	sessions, err := newClickStackSessionManager(testClickStackSessionKeys(), func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	authorizer := newClickStackSessionAuthorizer(
		sessionIntrospectorFunc(func(context.Context, string) (bool, error) { return active, nil }),
		func() time.Time { return now },
	)
	authorizer.Seed(binding)
	cookie, err := sessions.Issue(binding)
	if err != nil {
		t.Fatal(err)
	}
	proxied := 0
	handler := requireClickStackSession(
		sessions,
		authorizer,
		"https://backoffice.example.test/platform/observability",
		http.HandlerFunc(func(http.ResponseWriter, *http.Request) { proxied++ }),
	)

	request := httptest.NewRequest(http.MethodGet, "/clickstack", nil)
	request.AddCookie(cookie)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || proxied != 1 {
		t.Fatalf("active session did not reach ClickStack: status=%d proxied=%d", response.Code, proxied)
	}

	active = false
	now = now.Add(clickStackSessionValidationInterval + time.Second)
	request = httptest.NewRequest(http.MethodGet, "/clickstack", nil)
	request.AddCookie(cookie)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusSeeOther || proxied != 1 {
		t.Fatalf("inactive session reached ClickStack: status=%d proxied=%d", response.Code, proxied)
	}
	if setCookie := response.Header().Get("Set-Cookie"); !strings.Contains(setCookie, "Max-Age=0") {
		t.Fatalf("inactive session cookie was not cleared: %q", setCookie)
	}
}

func TestClickStackSessionMiddlewareFailsClosedWhenIntrospectionIsUnavailable(t *testing.T) {
	now := time.Date(2026, 8, 26, 10, 0, 0, 0, time.UTC)
	binding := testClickStackSessionBinding(now)
	sessions, err := newClickStackSessionManager(testClickStackSessionKeys(), func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	authorizer := newClickStackSessionAuthorizer(
		sessionIntrospectorFunc(func(context.Context, string) (bool, error) {
			return false, errors.New("synthetic Backoffice outage")
		}),
		func() time.Time { return now },
	)
	cookie, err := sessions.Issue(binding)
	if err != nil {
		t.Fatal(err)
	}
	handler := requireClickStackSession(
		sessions,
		authorizer,
		"https://backoffice.example.test/platform/observability",
		http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("request reached ClickStack") }),
	)
	request := httptest.NewRequest(http.MethodGet, "/clickstack", nil)
	request.AddCookie(cookie)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("unexpected response during introspection outage: %d", response.Code)
	}
	if response.Header().Get("Set-Cookie") != "" {
		t.Fatal("transient introspection error cleared the browser session")
	}
}

func TestClickStackBackofficeClientRedeemsAndIntrospectsBinding(t *testing.T) {
	now := time.Date(2026, 8, 26, 10, 0, 0, 0, time.UTC)
	binding := testClickStackSessionBinding(now)
	code := strings.Repeat("a", 43)
	requests := 0
	client := &httpClickStackBackofficeClient{
		redeemURL:     "https://backoffice.example.test/api/backoffice/v1/observability/clickstack/redeem",
		introspectURL: "https://backoffice.example.test/api/backoffice/v1/observability/clickstack/introspect",
		token:         testClickStackRedeemToken(),
		client: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			requests++
			if request.Method != http.MethodPost || request.Header.Get("Authorization") != "Bearer "+testClickStackRedeemToken() {
				t.Fatalf("Backoffice request was not authenticated")
			}
			body, err := io.ReadAll(request.Body)
			if err != nil {
				t.Fatal(err)
			}
			var payload map[string]string
			if err := json.Unmarshal(body, &payload); err != nil {
				t.Fatal(err)
			}
			responseBody := `{"active":true}`
			switch request.URL.Path {
			case "/api/backoffice/v1/observability/clickstack/redeem":
				if payload["code"] != code {
					t.Fatalf("unexpected redemption payload: %s", body)
				}
				responseBody = fmt.Sprintf(`{"active":true,"sessionId":%q,"expiresAt":%q}`, binding.ID, binding.ExpiresAt.Format(time.RFC3339))
			case "/api/backoffice/v1/observability/clickstack/introspect":
				if payload["sessionId"] != binding.ID {
					t.Fatalf("unexpected introspection payload: %s", body)
				}
			default:
				t.Fatalf("unexpected Backoffice path: %s", request.URL.Path)
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{"Content-Type": {"application/json"}},
				Body:       io.NopCloser(bytes.NewBufferString(responseBody)),
			}, nil
		})},
	}

	redeemed, err := client.Redeem(context.Background(), code)
	if err != nil || redeemed != binding {
		t.Fatalf("unexpected redeemed binding: %#v err=%v", redeemed, err)
	}
	active, err := client.Introspect(context.Background(), binding.ID)
	if err != nil || !active || requests != 2 {
		t.Fatalf("unexpected introspection: active=%t requests=%d err=%v", active, requests, err)
	}
}
