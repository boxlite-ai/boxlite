// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/boxlite-ai/image-service/internal/oci"
)

// An authenticated version check is how a client confirms it is talking to a
// registry it may use, and it must succeed once the credential is presented or
// no puller gets past discovery.
func TestAuthenticatedVersionCheckSucceeds(t *testing.T) {
	upstream := newStubUpstream(t)
	router, _ := testProxy(t, upstream, runnerPlane(t), "ghcr.io")

	response := pull(router, http.MethodGet, "/v2/", runnerKey)
	if response.Code != http.StatusOK {
		t.Fatalf("GET /v2/ = %d, want 200 for an authenticated caller: %s", response.Code, response.Body.String())
	}
	if got := response.Header().Get("Docker-Distribution-Api-Version"); got != "registry/2.0" {
		t.Errorf("Docker-Distribution-Api-Version = %q, want registry/2.0", got)
	}
}

// Over the limit the caller is told to come back, and told when. A 429 with no
// Retry-After invites an immediate retry that is refused again.
func TestOrganizationOverItsLimitIsToldWhenToReturn(t *testing.T) {
	upstream := newStubUpstream(t)
	router, proxy := testProxy(t, upstream, runnerPlane(t), "ghcr.io")
	proxy.limits = newPullLimiter(1, 1, 16)

	if first := pull(router, http.MethodGet, ghcrPath, runnerKey); first.Code != http.StatusOK {
		t.Fatalf("the first pull = %d: %s", first.Code, first.Body.String())
	}

	second := pull(router, http.MethodGet, ghcrPath, runnerKey)
	if second.Code != http.StatusTooManyRequests {
		t.Fatalf("the second pull = %d, want 429", second.Code)
	}
	assertRefusal(t, second.Body.Bytes(), oci.CodeTooManyRequests)

	retryAfter := second.Header().Get("Retry-After")
	seconds, err := strconv.Atoi(retryAfter)
	if err != nil {
		t.Fatalf("Retry-After = %q, want whole seconds: %v", retryAfter, err)
	}
	if seconds < 1 {
		t.Errorf("Retry-After = %d, want at least a second", seconds)
	}
	// The refused pull must not have been forwarded.
	if pulls := upstream.pulls(); len(pulls) != 1 {
		t.Errorf("upstream saw %d pulls, want only the allowed one", len(pulls))
	}
}

// The control plane is the only thing that can identify a caller, so its outage
// stops new callers. Saying that plainly beats a bare 500, which reads as a bug
// in this proxy and sends an operator looking in the wrong place.
func TestControlPlaneOutageIsReportedAsUnavailableNotAsAFailure(t *testing.T) {
	upstream := newStubUpstream(t)
	plane := runnerPlane(t)
	router, proxy := testProxy(t, upstream, plane, "ghcr.io")
	proxy.runners.api = plane.unreachable()

	response := pull(router, http.MethodGet, ghcrPath, runnerKey)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("a pull during a control-plane outage = %d, want 503", response.Code)
	}
	assertRefusal(t, response.Body.Bytes(), oci.CodeUnauthorized)
	if pulls := upstream.pulls(); len(pulls) != 0 {
		t.Errorf("an unverified caller reached the upstream: %+v", pulls)
	}
}

// A registry hands a blob off with a 302 and chooses the address itself. The
// end-to-end answer for one it must not follow is a denial the caller can read,
// not a hang or a bare gateway error.
func TestRedirectOffThePublicInternetIsRefusedToTheCaller(t *testing.T) {
	upstream := newStubUpstream(t)
	upstream.redirectBlob = "http://169.254.169.254/latest/meta-data/"
	router, proxy := testProxy(t, upstream, runnerPlane(t), "ghcr.io")
	// The registry is the stub; everything the registry then redirects to is
	// judged by the production rule.
	proxy.upstream = oci.NewClient(upstream.clientJudgingRedirects("ghcr.io"))
	proxy.tokens = newTokenBroker(proxy.upstream)

	path := "/v2/acme/ghcr.io/acme/app/blobs/sha256:ab12cd34"
	response := pull(router, http.MethodGet, path, runnerKey)
	if response.Code != http.StatusForbidden {
		t.Fatalf("a blob redirected off the public internet = %d, want 403: %s",
			response.Code, response.Body.String())
	}
	assertRefusal(t, response.Body.Bytes(), oci.CodeDenied)
	if bytes.Contains(response.Body.Bytes(), []byte("meta-data")) {
		t.Error("the metadata service's answer reached the caller")
	}
}

// A pull carries two credentials — the caller's key and the token the upstream
// issues — and this process's logs are the easiest place for either to escape
// to, since a log line outlives the request and travels further than it.
func TestNeitherCredentialAppearsInTheLogs(t *testing.T) {
	var logged bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logged, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(previous) })

	upstream := newStubUpstream(t)
	upstream.requireToken = true
	router, _ := testProxy(t, upstream, runnerPlane(t), "ghcr.io")

	if response := pull(router, http.MethodGet, ghcrPath, runnerKey); response.Code != http.StatusOK {
		t.Fatalf("GET %s = %d: %s", ghcrPath, response.Code, response.Body.String())
	}
	// And a refusal, which is the path most likely to report what it saw.
	pull(router, http.MethodGet, ghcrPath, "a-credential-that-is-wrong")
	pull(router, http.MethodGet, "/v2/acme/evil.example.com/x/manifests/1.2", runnerKey)

	for _, secret := range []string{runnerKey, upstream.issuedToken, "a-credential-that-is-wrong"} {
		if bytes.Contains(logged.Bytes(), []byte(secret)) {
			t.Errorf("a credential reached the logs: %q in %q", secret, logged.String())
		}
	}
}

// A refusal answered to the caller must not repeat what the caller sent, since
// a body travels further than a log line.
func TestRefusalBodiesDoNotRepeatTheCredential(t *testing.T) {
	upstream := newStubUpstream(t)
	router, _ := testProxy(t, upstream, runnerPlane(t), "ghcr.io")

	for _, recorder := range []*httptest.ResponseRecorder{
		pull(router, http.MethodGet, ghcrPath, "a-credential-that-is-wrong"),
		pull(router, http.MethodGet, "/v2/", "a-credential-that-is-wrong"),
	} {
		if bytes.Contains(recorder.Body.Bytes(), []byte("a-credential-that-is-wrong")) {
			t.Errorf("a refusal repeated the credential: %s", recorder.Body.String())
		}
	}
}
