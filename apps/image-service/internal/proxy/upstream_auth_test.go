// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"net/http"
	"sync"
	"testing"

	"github.com/boxlite-ai/image-service/internal/oci"
)

// ghcr and Docker Hub both answer an unauthenticated pull with a Bearer
// challenge and expect a token fetched from the realm it names. A proxy that
// cannot do that exchange can pull nothing from either.
func TestUpstreamChallengeIsAnsweredAndThePullRetried(t *testing.T) {
	upstream := newStubUpstream(t)
	upstream.requireToken = true
	router, _ := testProxy(t, upstream, runnerPlane(t), "ghcr.io")

	response := pull(router, http.MethodGet, ghcrPath, runnerKey)
	if response.Code != http.StatusOK {
		t.Fatalf("GET %s = %d: %s", ghcrPath, response.Code, response.Body.String())
	}
	if string(response.Body.Bytes()) != string(upstream.manifest) {
		t.Error("the retried pull did not return the manifest")
	}

	pulls := upstream.pulls()
	if len(pulls) != 2 {
		t.Fatalf("upstream saw %d pulls, want the refused one and the retry", len(pulls))
	}
	if pulls[0].authorization != "" {
		t.Errorf("the first pull carried %q, want nothing to have been sent before a challenge", pulls[0].authorization)
	}
	if want := "Bearer " + upstream.issuedToken; pulls[1].authorization != want {
		t.Errorf("the retry carried %q, want %q", pulls[1].authorization, want)
	}
}

// A token costs a round trip to the token endpoint. Fetching one per layer
// would triple the requests a single image pull makes.
func TestUpstreamTokenIsReusedAcrossPulls(t *testing.T) {
	upstream := newStubUpstream(t)
	upstream.requireToken = true
	router, _ := testProxy(t, upstream, runnerPlane(t), "ghcr.io")

	for range 3 {
		if response := pull(router, http.MethodGet, ghcrPath, runnerKey); response.Code != http.StatusOK {
			t.Fatalf("GET %s = %d: %s", ghcrPath, response.Code, response.Body.String())
		}
	}

	if issued := upstream.tokensIssued(); issued != 1 {
		t.Errorf("the token endpoint was asked %d times, want 1", issued)
	}
	// One refused pull to learn the challenge, then three that carried the
	// token: four in total rather than six.
	if pulls := upstream.pulls(); len(pulls) != 4 {
		t.Errorf("upstream saw %d pulls, want 4", len(pulls))
	}
}

// A token is scoped to one repository, so one issued for another is refused by
// every pull it is offered to.
func TestUpstreamTokensAreKeptPerRepositoryAndOrganization(t *testing.T) {
	first := oci.Upstream{Endpoint: "ghcr.io", Repository: "acme/app"}
	second := oci.Upstream{Endpoint: "ghcr.io", Repository: "acme/other"}

	if tokenKey("acme", first) == tokenKey("acme", second) {
		t.Error("two repositories share a token key, so a scoped token would be offered where it cannot work")
	}
	if tokenKey("acme", first) == tokenKey("globex", first) {
		t.Error("two organizations share a token key")
	}
}

// An upstream that refuses even after the exchange is a denial the caller can
// act on, and it must not be answered with a challenge of our own.
func TestAnUpstreamThatKeepsRefusingIsReportedAsDenied(t *testing.T) {
	upstream := newStubUpstream(t)
	upstream.requireToken = true
	router, _ := testProxy(t, upstream, runnerPlane(t), "ghcr.io")

	// The token endpoint hands out something the registry will not accept, so
	// the retry is refused too.
	upstream.server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"token":"a-token-the-registry-rejects"}`))
			return
		}
		w.Header().Set("Www-Authenticate", `Bearer realm="https://`+r.Host+`/token",service="`+r.Host+`"`)
		w.WriteHeader(http.StatusUnauthorized)
	})

	response := pull(router, http.MethodGet, ghcrPath, runnerKey)
	if response.Code != http.StatusForbidden {
		t.Fatalf("a pull the upstream keeps refusing = %d, want 403", response.Code)
	}
	if got := response.Header().Get("Www-Authenticate"); got != "" {
		t.Errorf("the answer carried a challenge %q, which a client would loop on", got)
	}
	assertRefusal(t, response.Body.Bytes(), oci.CodeDenied)
}

// A token endpoint that fails is an outage upstream, not a refusal: answering it
// as a denial would send an operator looking for a missing credential.
func TestAFailingTokenEndpointIsReportedAsUnreachable(t *testing.T) {
	upstream := newStubUpstream(t)
	router, _ := testProxy(t, upstream, runnerPlane(t), "ghcr.io")
	upstream.server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.Header().Set("Www-Authenticate", `Bearer realm="https://`+r.Host+`/token",service="`+r.Host+`"`)
		w.WriteHeader(http.StatusUnauthorized)
	})

	response := pull(router, http.MethodGet, ghcrPath, runnerKey)
	if response.Code != http.StatusBadGateway {
		t.Fatalf("a pull whose token exchange failed = %d, want 502", response.Code)
	}
	assertRefusal(t, response.Body.Bytes(), oci.CodeUnsupported)
}

// A Basic challenge asks for a credential this release does not hold. The
// runner's own key authenticates it to this proxy and must never be what is
// offered upstream in its place.
func TestABasicChallengeIsRetriedWithoutACredential(t *testing.T) {
	upstream := newStubUpstream(t)
	router, _ := testProxy(t, upstream, runnerPlane(t), "ghcr.io")
	var (
		mu   sync.Mutex
		seen []string
	)
	upstream.server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Header.Get("Authorization"))
		mu.Unlock()
		w.Header().Set("Www-Authenticate", `Basic realm="registry"`)
		w.WriteHeader(http.StatusUnauthorized)
	})

	response := pull(router, http.MethodGet, ghcrPath, runnerKey)
	if response.Code != http.StatusForbidden {
		t.Fatalf("a pull behind a Basic challenge = %d, want 403", response.Code)
	}
	assertRefusal(t, response.Body.Bytes(), oci.CodeDenied)
	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 2 {
		t.Fatalf("upstream saw %d pulls, want the refused one and one retry", len(seen))
	}
	for i, authorization := range seen {
		if authorization != "" {
			t.Errorf("pull %d carried %q upstream, want no credential at all", i+1, authorization)
		}
	}
}

// A Bearer challenge without a realm names nowhere to fetch a token, so the
// pull fails as unreachable rather than being retried blind.
func TestABearerChallengeWithoutARealmIsReportedAsUnreachable(t *testing.T) {
	upstream := newStubUpstream(t)
	router, _ := testProxy(t, upstream, runnerPlane(t), "ghcr.io")
	upstream.server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Www-Authenticate", `Bearer service="ghcr.io"`)
		w.WriteHeader(http.StatusUnauthorized)
	})

	response := pull(router, http.MethodGet, ghcrPath, runnerKey)
	if response.Code != http.StatusBadGateway {
		t.Fatalf("a pull behind a challenge with no realm = %d, want 502", response.Code)
	}
	assertRefusal(t, response.Body.Bytes(), oci.CodeUnsupported)
}

// A 401 that names no way to authenticate leaves nothing to answer, so the pull
// fails as unreachable rather than being retried blind.
func TestAnUpstreamRefusalWithoutAChallengeIsReportedAsUnreachable(t *testing.T) {
	upstream := newStubUpstream(t)
	router, _ := testProxy(t, upstream, runnerPlane(t), "ghcr.io")
	upstream.server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	})

	response := pull(router, http.MethodGet, ghcrPath, runnerKey)
	if response.Code != http.StatusBadGateway {
		t.Fatalf("a pull refused with no challenge = %d, want 502", response.Code)
	}
	assertRefusal(t, response.Body.Bytes(), oci.CodeUnsupported)
}
