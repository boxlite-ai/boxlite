// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
)

// stubControlPlane answers the one endpoint the registry proxy asks: who does
// this API key belong to?
type stubControlPlane struct {
	server *httptest.Server
	// asked counts round trips, which is how caching is observed: a cache that
	// is not consulted looks identical from the outside except for this.
	asked atomic.Int64
	// stopped makes the control plane unreachable without changing its answers.
	stopped atomic.Bool
}

func newStubControlPlane(t *testing.T, keyToRunner map[string]string) *stubControlPlane {
	t.Helper()
	plane := &stubControlPlane{}
	plane.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		plane.asked.Add(1)
		if r.URL.Path != "/runners/me" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		key := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		runnerID, known := keyToRunner[key]
		if !known {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		// Every field the generated model requires. Note apiKey: the control
		// plane answers this endpoint with the runner's own key, so the reply
		// is a credential and must not be logged or cached whole.
		_, _ = io.WriteString(w, `{"id":"`+runnerID+`","name":"`+runnerID+`","cpu":1,"memory":1,"disk":1,`+
			`"class":"small","region":"eu","state":"ready","unschedulable":false,`+
			`"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z",`+
			`"version":"1","apiVersion":"2","apiKey":"the-runners-own-key"}`)
	}))
	t.Cleanup(plane.server.Close)
	return plane
}

func (p *stubControlPlane) client() *apiclient.APIClient {
	configuration := apiclient.NewConfiguration()
	configuration.Servers = apiclient.ServerConfigurations{{URL: p.server.URL}}
	return apiclient.NewAPIClient(configuration)
}

// unreachable replaces the control plane with one that is not listening, which
// is what a restart looks like from here.
func (p *stubControlPlane) unreachable() *apiclient.APIClient {
	configuration := apiclient.NewConfiguration()
	// Port 1 on loopback: nothing listens, and the refusal is immediate.
	configuration.Servers = apiclient.ServerConfigurations{{URL: "http://127.0.0.1:1"}}
	return apiclient.NewAPIClient(configuration)
}

func TestAuthenticateResolvesTheRunnerBehindAKey(t *testing.T) {
	plane := newStubControlPlane(t, map[string]string{"good-key": "runner-7"})
	authenticator := newRunnerAuthenticator(plane.client(), time.Minute, time.Minute)

	runnerID, err := authenticator.authenticate(context.Background(), "good-key")
	if err != nil {
		t.Fatalf("authenticate failed: %v", err)
	}
	if runnerID != "runner-7" {
		t.Errorf("runner = %q, want the one the control plane named", runnerID)
	}
}

// Every pull would otherwise be a control-plane round trip, which puts the
// control plane on the pull path for every layer of every image.
func TestAuthenticateAsksTheControlPlaneOncePerCredential(t *testing.T) {
	plane := newStubControlPlane(t, map[string]string{"good-key": "runner-7"})
	authenticator := newRunnerAuthenticator(plane.client(), time.Minute, time.Minute)

	for range 5 {
		if _, err := authenticator.authenticate(context.Background(), "good-key"); err != nil {
			t.Fatalf("authenticate failed: %v", err)
		}
	}
	if asked := plane.asked.Load(); asked != 1 {
		t.Errorf("control plane asked %d times, want 1", asked)
	}
}

// This proxy accepts connections from anywhere, so without remembering a
// refusal a caller with a bad key turns it into a load generator aimed at the
// control plane.
func TestAuthenticateRemembersARefusal(t *testing.T) {
	plane := newStubControlPlane(t, map[string]string{"good-key": "runner-7"})
	authenticator := newRunnerAuthenticator(plane.client(), time.Minute, time.Minute)

	for range 5 {
		if _, err := authenticator.authenticate(context.Background(), "bad-key"); !errors.Is(err, ErrUnauthenticated) {
			t.Fatalf("authenticate failed with %v, want %v", err, ErrUnauthenticated)
		}
	}
	if asked := plane.asked.Load(); asked != 1 {
		t.Errorf("control plane asked %d times, want 1", asked)
	}
}

func TestAuthenticateRefusesAnEmptyCredentialWithoutAsking(t *testing.T) {
	plane := newStubControlPlane(t, map[string]string{})
	authenticator := newRunnerAuthenticator(plane.client(), time.Minute, time.Minute)

	if _, err := authenticator.authenticate(context.Background(), ""); !errors.Is(err, ErrUnauthenticated) {
		t.Errorf("authenticate failed with %v, want %v", err, ErrUnauthenticated)
	}
	if asked := plane.asked.Load(); asked != 0 {
		t.Errorf("control plane asked %d times for an empty credential, want 0", asked)
	}
}

// A pull already under way must not fail because the control plane restarted.
func TestAuthenticateServesAKnownCallerWhileTheControlPlaneIsDown(t *testing.T) {
	plane := newStubControlPlane(t, map[string]string{"good-key": "runner-7"})
	authenticator := newRunnerAuthenticator(plane.client(), time.Minute, time.Minute)

	if _, err := authenticator.authenticate(context.Background(), "good-key"); err != nil {
		t.Fatalf("authenticate failed: %v", err)
	}

	authenticator.api = plane.unreachable()
	runnerID, err := authenticator.authenticate(context.Background(), "good-key")
	if err != nil {
		t.Fatalf("a cached caller was refused while the control plane was down: %v", err)
	}
	if runnerID != "runner-7" {
		t.Errorf("runner = %q, want the cached answer", runnerID)
	}
}

// The other half of the same decision: an unknown caller is not admitted just
// because nobody can be asked, or the control plane's outage becomes a way in.
func TestAuthenticateRefusesAnUnknownCallerWhileTheControlPlaneIsDown(t *testing.T) {
	plane := newStubControlPlane(t, map[string]string{"good-key": "runner-7"})
	authenticator := newRunnerAuthenticator(plane.unreachable(), time.Minute, time.Minute)

	_, err := authenticator.authenticate(context.Background(), "good-key")
	if !errors.Is(err, ErrAuthUnavailable) {
		t.Fatalf("authenticate failed with %v, want %v", err, ErrAuthUnavailable)
	}
	// Unavailable is not refused: recording it as a refusal would keep the
	// caller out for the whole negative TTL after the control plane returns.
	if errors.Is(err, ErrUnauthenticated) {
		t.Error("an outage was recorded as a refusal")
	}
}

// A credential that stops being valid has to stop working, so what is cached is
// an answer with a shelf life rather than a decision.
func TestAuthenticateAsksAgainOnceTheAnswerHasExpired(t *testing.T) {
	plane := newStubControlPlane(t, map[string]string{"good-key": "runner-7"})
	authenticator := newRunnerAuthenticator(plane.client(), time.Minute, time.Minute)

	clock := time.Now()
	authenticator.verified.now = func() time.Time { return clock }
	authenticator.rejected.now = func() time.Time { return clock }

	if _, err := authenticator.authenticate(context.Background(), "good-key"); err != nil {
		t.Fatalf("authenticate failed: %v", err)
	}
	clock = clock.Add(2 * time.Minute)
	if _, err := authenticator.authenticate(context.Background(), "good-key"); err != nil {
		t.Fatalf("authenticate failed after expiry: %v", err)
	}
	if asked := plane.asked.Load(); asked != 2 {
		t.Errorf("control plane asked %d times, want 2 — once before expiry and once after", asked)
	}
}

// The cache is keyed by a digest so the credential itself is not a map key held
// for as long as the entry lives.
func TestCredentialKeyDoesNotHoldTheCredential(t *testing.T) {
	key := credentialKey("hunter2-the-runner-key")
	if strings.Contains(key, "hunter2") {
		t.Errorf("the cache key carries the credential: %q", key)
	}
	if key == credentialKey("a-different-key") {
		t.Error("two credentials share a cache key")
	}
}

// A control plane that answers but fails is as unavailable as one that does not
// answer at all, and must not be recorded as a refusal: that would keep a real
// runner out for the whole negative TTL after the control plane recovered.
func TestAuthenticateReadsAFailingControlPlaneAsUnavailable(t *testing.T) {
	failing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	t.Cleanup(failing.Close)

	configuration := apiclient.NewConfiguration()
	configuration.Servers = apiclient.ServerConfigurations{{URL: failing.URL}}
	authenticator := newRunnerAuthenticator(apiclient.NewAPIClient(configuration), time.Minute, time.Minute)

	_, err := authenticator.authenticate(context.Background(), "a-key")
	if !errors.Is(err, ErrAuthUnavailable) {
		t.Fatalf("authenticate failed with %v, want %v", err, ErrAuthUnavailable)
	}
	if _, remembered := authenticator.rejected.get(credentialKey("a-key")); remembered {
		t.Error("a control-plane failure was remembered as a refusal of the credential")
	}
}

// An answer that names no runner is not a runner, whatever its status says, and
// admitting it would authenticate a caller as nobody in particular.
func TestAuthenticateRefusesAnAnswerThatNamesNoRunner(t *testing.T) {
	anonymous := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"","name":"","cpu":1,"memory":1,"disk":1,"class":"small","region":"eu",`+
			`"state":"ready","unschedulable":false,"createdAt":"2026-01-01T00:00:00Z",`+
			`"updatedAt":"2026-01-01T00:00:00Z","version":"1","apiVersion":"2","apiKey":"k"}`)
	}))
	t.Cleanup(anonymous.Close)

	configuration := apiclient.NewConfiguration()
	configuration.Servers = apiclient.ServerConfigurations{{URL: anonymous.URL}}
	authenticator := newRunnerAuthenticator(apiclient.NewAPIClient(configuration), time.Minute, time.Minute)

	runnerID, err := authenticator.authenticate(context.Background(), "a-key")
	if !errors.Is(err, ErrAuthUnavailable) {
		t.Fatalf("authenticate = %q, %v; want %v", runnerID, err, ErrAuthUnavailable)
	}
	// The same sentinel is what a body the client could not decode produces, so
	// the reason is pinned too — or this would pass on the wrong branch.
	if !strings.Contains(err.Error(), "named no runner") {
		t.Errorf("refused for %q, want the answer's missing runner to be the reason", err)
	}
	if _, cached := authenticator.verified.get(credentialKey("a-key")); cached {
		t.Error("an answer naming no runner was cached as a verified caller")
	}
}
