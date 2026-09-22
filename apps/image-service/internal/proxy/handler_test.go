// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/boxlite-ai/image-service/internal/oci"
)

const (
	runnerKey = "runner-api-key"
	ghcrPath  = "/v2/acme/ghcr.io/acme/app/manifests/1.2"
)

func runnerPlane(t *testing.T) *stubControlPlane {
	t.Helper()
	return newStubControlPlane(t, map[string]string{runnerKey: "runner-7"})
}

// The whole proxy rests on this. A manifest's digest covers the bytes the
// upstream served, so anything re-encoded on the way through breaks the pull —
// and breaks it as "some images fail sometimes", which is the hardest shape of
// bug to place.
func TestManifestArrivesByteForByteWithItsDigestIntact(t *testing.T) {
	upstream := newStubUpstream(t)
	router, _ := testProxy(t, upstream, runnerPlane(t), "ghcr.io")

	response := pull(router, http.MethodGet, ghcrPath, runnerKey)
	if response.Code != http.StatusOK {
		t.Fatalf("GET %s = %d: %s", ghcrPath, response.Code, response.Body.String())
	}

	relayed := response.Body.Bytes()
	if string(relayed) != string(upstream.manifest) {
		t.Errorf("relayed manifest = %q, want the upstream's bytes %q", relayed, upstream.manifest)
	}
	// The digest is recomputed over what actually arrived, so a single byte of
	// difference fails here even if the header were copied faithfully.
	if got, want := digestOf(relayed), response.Header().Get("Docker-Content-Digest"); got != want {
		t.Errorf("digest of the relayed bytes = %s, but the header says %s", got, want)
	}
	if got := response.Header().Get("Content-Type"); got != upstream.manifestType {
		t.Errorf("Content-Type = %q, want the upstream's %q", got, upstream.manifestType)
	}
}

// The path the caller writes carries an organization and a registry host that
// the upstream has never heard of. Rewriting them must not reach the payload.
func TestOrgPathRewriteLeavesTheUpstreamRequestAndTheDigestAlone(t *testing.T) {
	upstream := newStubUpstream(t)
	router, _ := testProxy(t, upstream, runnerPlane(t), "ghcr.io")

	response := pull(router, http.MethodGet, ghcrPath, runnerKey)
	if response.Code != http.StatusOK {
		t.Fatalf("GET %s = %d: %s", ghcrPath, response.Code, response.Body.String())
	}

	pulls := upstream.pulls()
	if len(pulls) != 1 {
		t.Fatalf("upstream saw %d pulls, want 1", len(pulls))
	}
	if want := "/v2/acme/app/manifests/1.2"; pulls[0].path != want {
		t.Errorf("upstream saw %q, want %q with the routing segments stripped", pulls[0].path, want)
	}
	if digestOf(response.Body.Bytes()) != digestOf(upstream.manifest) {
		t.Error("the relayed manifest does not hash to what the upstream served")
	}
}

// docker.io serves the website. A pull that keeps the published host fails for
// every Docker Hub image while ghcr keeps working, so the assertion is on the
// host the upstream request actually carried.
func TestDockerHubPullAddressesTheRegistryEndpoint(t *testing.T) {
	upstream := newStubUpstream(t)
	router, _ := testProxy(t, upstream, runnerPlane(t), "docker.io")

	path := "/v2/acme/docker.io/alpine/manifests/3.20"
	if response := pull(router, http.MethodGet, path, runnerKey); response.Code != http.StatusOK {
		t.Fatalf("GET %s = %d: %s", path, response.Code, response.Body.String())
	}

	pulls := upstream.pulls()
	if len(pulls) != 1 {
		t.Fatalf("upstream saw %d pulls, want 1", len(pulls))
	}
	if pulls[0].host != "registry-1.docker.io" {
		t.Errorf("upstream request went to %q, want registry-1.docker.io", pulls[0].host)
	}
	if want := "/v2/library/alpine/manifests/3.20"; pulls[0].path != want {
		t.Errorf("upstream saw %q, want %q with the implied namespace", pulls[0].path, want)
	}
}

// Accept decides which manifest media type comes back, so dropping it turns an
// image index into "manifest unknown" for clients that asked for one.
func TestAcceptIsForwardedAndTheCallerCredentialIsNot(t *testing.T) {
	upstream := newStubUpstream(t)
	router, _ := testProxy(t, upstream, runnerPlane(t), "ghcr.io")

	if response := pull(router, http.MethodGet, ghcrPath, runnerKey); response.Code != http.StatusOK {
		t.Fatalf("GET %s = %d: %s", ghcrPath, response.Code, response.Body.String())
	}

	pulls := upstream.pulls()
	if len(pulls) != 1 {
		t.Fatalf("upstream saw %d pulls, want 1", len(pulls))
	}
	if len(pulls[0].accept) != 1 || pulls[0].accept[0] != "application/vnd.oci.image.manifest.v1+json" {
		t.Errorf("upstream saw Accept %v, want the caller's", pulls[0].accept)
	}
	// The caller's credential authenticates it to this proxy and means nothing
	// upstream; sending it on would hand a runner's key to a third party.
	if strings.Contains(pulls[0].authorization, runnerKey) {
		t.Errorf("the caller's credential reached the upstream: %q", pulls[0].authorization)
	}
}

// HEAD is how a client checks a tag without downloading it, and it has to carry
// the same headers as the GET or the check means nothing.
func TestHeadManifestAnswersWithHeadersAndNoBody(t *testing.T) {
	upstream := newStubUpstream(t)
	router, _ := testProxy(t, upstream, runnerPlane(t), "ghcr.io")

	response := pull(router, http.MethodHead, ghcrPath, runnerKey)
	if response.Code != http.StatusOK {
		t.Fatalf("HEAD %s = %d: %s", ghcrPath, response.Code, response.Body.String())
	}
	if response.Body.Len() != 0 {
		t.Errorf("HEAD returned %d bytes of body", response.Body.Len())
	}
	if got := response.Header().Get("Docker-Content-Digest"); got != digestOf(upstream.manifest) {
		t.Errorf("Docker-Content-Digest = %q, want the manifest's digest", got)
	}
	if pulls := upstream.pulls(); len(pulls) != 1 || pulls[0].method != http.MethodHead {
		t.Errorf("upstream saw %+v, want one HEAD", pulls)
	}
}

func TestBlobIsRelayedFromTheUpstream(t *testing.T) {
	upstream := newStubUpstream(t)
	router, _ := testProxy(t, upstream, runnerPlane(t), "ghcr.io")

	path := "/v2/acme/ghcr.io/acme/app/blobs/" + digestOf(upstream.blob)
	response := pull(router, http.MethodGet, path, runnerKey)
	if response.Code != http.StatusOK {
		t.Fatalf("GET blob = %d: %s", response.Code, response.Body.String())
	}
	if string(response.Body.Bytes()) != string(upstream.blob) {
		t.Errorf("relayed blob = %q, want %q", response.Body.Bytes(), upstream.blob)
	}
}

func TestUnauthenticatedPullIsChallenged(t *testing.T) {
	upstream := newStubUpstream(t)
	router, _ := testProxy(t, upstream, runnerPlane(t), "ghcr.io")

	response := pull(router, http.MethodGet, ghcrPath, "")
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("an unauthenticated pull = %d, want 401", response.Code)
	}
	if got := response.Header().Get("Www-Authenticate"); got != `Basic realm="`+Realm+`"` {
		t.Errorf("challenge = %q, want a Basic challenge", got)
	}
	if pulls := upstream.pulls(); len(pulls) != 0 {
		t.Errorf("an unauthenticated pull reached the upstream: %+v", pulls)
	}
}

func TestWrongCredentialIsRefusedWithoutReachingTheUpstream(t *testing.T) {
	upstream := newStubUpstream(t)
	router, _ := testProxy(t, upstream, runnerPlane(t), "ghcr.io")

	response := pull(router, http.MethodGet, ghcrPath, "not-a-runner-key")
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("a wrong credential = %d, want 401", response.Code)
	}
	assertRefusal(t, response.Body.Bytes(), oci.CodeUnauthorized)
	if pulls := upstream.pulls(); len(pulls) != 0 {
		t.Errorf("a refused caller reached the upstream: %+v", pulls)
	}
}

// The upstream host comes from the request path, so an authenticated caller
// would otherwise choose what this process connects to.
func TestHostOutsideTheAllowlistIsRefused(t *testing.T) {
	upstream := newStubUpstream(t)
	router, _ := testProxy(t, upstream, runnerPlane(t), "ghcr.io")

	path := "/v2/acme/registry.evil.example.com/acme/app/manifests/1.2"
	response := pull(router, http.MethodGet, path, runnerKey)
	if response.Code != http.StatusForbidden {
		t.Fatalf("a host outside the allowlist = %d, want 403", response.Code)
	}
	assertRefusal(t, response.Body.Bytes(), oci.CodeDenied)
	if pulls := upstream.pulls(); len(pulls) != 0 {
		t.Errorf("a refused host was still contacted: %+v", pulls)
	}
}

func TestPathThatIsNotAPullIsNotFound(t *testing.T) {
	upstream := newStubUpstream(t)
	router, _ := testProxy(t, upstream, runnerPlane(t), "ghcr.io")

	for _, path := range []string{
		"/v2/acme/ghcr.io/acme/app/tags/list",
		"/v2/acme/ghcr.io/acme/app/blobs/uploads/abc",
	} {
		if response := pull(router, http.MethodGet, path, runnerKey); response.Code != http.StatusNotFound {
			t.Errorf("GET %s = %d, want 404", path, response.Code)
		}
	}
}

// A name that does not carry an organization and a host cannot be routed, and
// saying so beats forwarding a guess.
func TestNameWithoutARouteIsRejected(t *testing.T) {
	upstream := newStubUpstream(t)
	router, _ := testProxy(t, upstream, runnerPlane(t), "ghcr.io")

	response := pull(router, http.MethodGet, "/v2/acme/manifests/1.2", runnerKey)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("an unroutable name = %d, want 400", response.Code)
	}
	assertRefusal(t, response.Body.Bytes(), oci.CodeNameInvalid)
}

func assertRefusal(t *testing.T, body []byte, want oci.ErrorCode) {
	t.Helper()
	var refusal oci.ErrorBody
	if err := json.Unmarshal(body, &refusal); err != nil {
		t.Fatalf("refusal body %q is not the shape the specification gives refusals: %v", body, err)
	}
	if len(refusal.Errors) != 1 || refusal.Errors[0].Code != want {
		t.Errorf("refusal = %+v, want a single %s", refusal.Errors, want)
	}
}

// Some of what a registry answers describes its connection to this proxy rather
// than the pull, and one of them would send the caller into a loop: relaying
// the upstream's own challenge tells the caller to authenticate to a registry
// it holds no credential for, which is the reason this proxy exists.
func TestConnectionHeadersAndTheUpstreamChallengeAreNotRelayed(t *testing.T) {
	upstream := newStubUpstream(t)
	router, _ := testProxy(t, upstream, runnerPlane(t), "ghcr.io")

	upstream.server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Www-Authenticate", `Bearer realm="https://ghcr.io/token"`)
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("Trailer", "Expires")
		w.Header().Set("Docker-Content-Digest", digestOf(upstream.manifest))
		w.Header().Set("Content-Type", upstream.manifestType)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(upstream.manifest)
	})

	response := pull(router, http.MethodGet, ghcrPath, runnerKey)
	if response.Code != http.StatusOK {
		t.Fatalf("GET %s = %d: %s", ghcrPath, response.Code, response.Body.String())
	}
	for _, name := range []string{"Www-Authenticate", "Connection", "Trailer"} {
		if got := response.Header().Get(name); got != "" {
			t.Errorf("%s was relayed as %q", name, got)
		}
	}
	// What describes the pull itself still comes through.
	if got := response.Header().Get("Docker-Content-Digest"); got != digestOf(upstream.manifest) {
		t.Errorf("Docker-Content-Digest = %q, want the manifest's digest", got)
	}
}

// A registry may serve a manifest compressed. Go's transport offers gzip on
// every request that did not set Accept-Encoding itself, and then decodes the
// answer and drops Content-Encoding and Content-Length on the way — so the
// caller would receive different bytes under a digest that no longer covers
// them, which is the one invariant this proxy exists to hold.
func TestACompressedManifestIsRelayedStillCompressed(t *testing.T) {
	upstream := newStubUpstream(t)
	router, _ := testProxy(t, upstream, runnerPlane(t), "ghcr.io")

	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	if _, err := writer.Write(upstream.manifest); err != nil {
		t.Fatalf("compress the manifest: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close the compressor: %v", err)
	}
	served := compressed.Bytes()

	upstream.server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Accept-Encoding"); got != "" {
			t.Errorf("upstream was offered %q although the caller asked for no encoding", got)
		}
		w.Header().Set("Content-Type", upstream.manifestType)
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Set("Docker-Content-Digest", digestOf(served))
		w.Header().Set("Content-Length", strconv.Itoa(len(served)))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(served)
	})

	response := pull(router, http.MethodGet, ghcrPath, runnerKey)
	if response.Code != http.StatusOK {
		t.Fatalf("GET %s = %d: %s", ghcrPath, response.Code, response.Body.String())
	}

	relayed := response.Body.Bytes()
	if !bytes.Equal(relayed, served) {
		t.Errorf("relayed %d bytes, want the %d the upstream served", len(relayed), len(served))
	}
	if digestOf(relayed) != response.Header().Get("Docker-Content-Digest") {
		t.Error("the relayed bytes no longer hash to the digest the upstream stated")
	}
	if got := response.Header().Get("Content-Encoding"); got != "gzip" {
		t.Errorf("Content-Encoding = %q, want gzip — without it the caller cannot read the body", got)
	}
}

// The other half: a caller that asks for an encoding gets it passed through,
// since the encoding is then its own to undo.
func TestACallerThatAsksForAnEncodingHasItForwarded(t *testing.T) {
	upstream := newStubUpstream(t)
	router, _ := testProxy(t, upstream, runnerPlane(t), "ghcr.io")

	request := httptest.NewRequest(http.MethodGet, ghcrPath, nil)
	request.SetBasicAuth("runner", runnerKey)
	request.Header.Set("Accept-Encoding", "gzip")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("GET %s = %d: %s", ghcrPath, recorder.Code, recorder.Body.String())
	}
	pulls := upstream.pulls()
	if len(pulls) != 1 {
		t.Fatalf("upstream saw %d pulls, want 1", len(pulls))
	}
	if pulls[0].acceptEncoding != "gzip" {
		t.Errorf("upstream saw Accept-Encoding %q, want the caller's gzip", pulls[0].acceptEncoding)
	}
}
