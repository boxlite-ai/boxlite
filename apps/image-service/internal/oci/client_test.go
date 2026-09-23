// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package oci

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// recordingUpstream answers every request with body and records what it was
// asked for, so a test can assert on the request that actually crossed the
// wire rather than on the URL the client meant to build.
type recordingUpstream struct {
	server *httptest.Server
	method string
	// rawPath is the path as it arrived, before Go decodes it: a digest's colon
	// escaped on the way out would show up here and nowhere else.
	rawPath string
	header  http.Header
}

func newRecordingUpstream(t *testing.T, status int, header http.Header, body []byte) *recordingUpstream {
	t.Helper()
	upstream := &recordingUpstream{}
	upstream.server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstream.method = r.Method
		upstream.rawPath = r.URL.EscapedPath()
		upstream.header = r.Header.Clone()
		for name, values := range header {
			for _, value := range values {
				w.Header().Add(name, value)
			}
		}
		w.WriteHeader(status)
		_, _ = w.Write(body)
	}))
	t.Cleanup(upstream.server.Close)
	return upstream
}

func (u *recordingUpstream) endpoint() string { return u.server.Listener.Addr().String() }

func (u *recordingUpstream) client() *Client { return NewClient(u.server.Client()) }

// A digest is a path segment containing a colon. Escaping it to %3A produces a
// URL every registry answers with 404, and the failure looks like a missing
// blob rather than a client bug, so the bytes on the wire are what is asserted.
func TestPullAddressesTheUpstreamRepositoryVerbatim(t *testing.T) {
	upstream := newRecordingUpstream(t, http.StatusOK, nil, nil)

	request, err := ParseRequest("/v2/acme/ghcr.io/acme/app/blobs/sha256:ab12cd34")
	if err != nil {
		t.Fatalf("ParseRequest failed: %v", err)
	}
	resolved, err := ResolveUpstream("ghcr.io", "acme/app")
	if err != nil {
		t.Fatalf("ResolveUpstream failed: %v", err)
	}
	resolved.Endpoint = upstream.endpoint()

	response, err := upstream.client().Pull(context.Background(), http.MethodGet, resolved, request, nil)
	if err != nil {
		t.Fatalf("Pull failed: %v", err)
	}
	defer response.Body.Close()

	if want := "/v2/acme/app/blobs/sha256:ab12cd34"; upstream.rawPath != want {
		t.Errorf("upstream saw path %q, want %q", upstream.rawPath, want)
	}
	if upstream.method != http.MethodGet {
		t.Errorf("upstream saw method %q, want GET", upstream.method)
	}
}

// The digest a client verifies covers the manifest bytes as the upstream served
// them, so anything the client re-encodes on the way through breaks the pull.
func TestPullReturnsTheUpstreamResponseUntouched(t *testing.T) {
	manifest := []byte(`{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json"}`)
	upstreamHeader := http.Header{
		"Content-Type":          {"application/vnd.oci.image.manifest.v1+json"},
		"Docker-Content-Digest": {"sha256:ab12cd34"},
	}
	upstream := newRecordingUpstream(t, http.StatusOK, upstreamHeader, manifest)

	request, err := ParseRequest("/v2/acme/app/manifests/1.2")
	if err != nil {
		t.Fatalf("ParseRequest failed: %v", err)
	}
	response, err := upstream.client().Pull(context.Background(), http.MethodGet,
		Upstream{Endpoint: upstream.endpoint(), Repository: "acme/app"}, request, nil)
	if err != nil {
		t.Fatalf("Pull failed: %v", err)
	}
	defer response.Body.Close()

	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	if string(body) != string(manifest) {
		t.Errorf("body = %q, want %q", body, manifest)
	}
	for name, want := range map[string]string{
		"Content-Type":          "application/vnd.oci.image.manifest.v1+json",
		"Docker-Content-Digest": "sha256:ab12cd34",
	} {
		if got := response.Header.Get(name); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
}

// An upstream refusal is an answer about the pull, not a transport failure, so
// it reaches the caller as a response it can forward.
func TestPullReturnsAnUpstreamRefusalAsAResponse(t *testing.T) {
	upstream := newRecordingUpstream(t, http.StatusUnauthorized,
		http.Header{"Www-Authenticate": {`Bearer realm="https://ghcr.io/token",service="ghcr.io"`}}, nil)

	request, err := ParseRequest("/v2/acme/app/manifests/1.2")
	if err != nil {
		t.Fatalf("ParseRequest failed: %v", err)
	}
	response, err := upstream.client().Pull(context.Background(), http.MethodGet,
		Upstream{Endpoint: upstream.endpoint(), Repository: "acme/app"}, request, nil)
	if err != nil {
		t.Fatalf("Pull returned an error for a 401: %v", err)
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", response.StatusCode)
	}
	if got := response.Header.Get("Www-Authenticate"); got == "" {
		t.Error("the challenge that tells a client what to do next was dropped")
	}
}

func TestPullForwardsTheHeadersItIsGiven(t *testing.T) {
	upstream := newRecordingUpstream(t, http.StatusOK, nil, nil)

	request, err := ParseRequest("/v2/acme/app/manifests/1.2")
	if err != nil {
		t.Fatalf("ParseRequest failed: %v", err)
	}
	header := http.Header{"Accept": {
		"application/vnd.oci.image.manifest.v1+json",
		"application/vnd.oci.image.index.v1+json",
	}}
	response, err := upstream.client().Pull(context.Background(), http.MethodHead,
		Upstream{Endpoint: upstream.endpoint(), Repository: "acme/app"}, request, header)
	if err != nil {
		t.Fatalf("Pull failed: %v", err)
	}
	defer response.Body.Close()

	if got := upstream.header.Values("Accept"); len(got) != 2 {
		t.Errorf("upstream saw Accept %v, want both media types", got)
	}
	if upstream.method != http.MethodHead {
		t.Errorf("upstream saw method %q, want HEAD", upstream.method)
	}
}

func TestPullRefusesMethodsThatAreNotPulls(t *testing.T) {
	upstream := newRecordingUpstream(t, http.StatusOK, nil, nil)
	request := Request{Name: "acme/app", Kind: KindManifest, Reference: "1.2"}

	for _, method := range []string{http.MethodPut, http.MethodPost, http.MethodDelete, http.MethodPatch} {
		response, err := upstream.client().Pull(context.Background(), method,
			Upstream{Endpoint: upstream.endpoint(), Repository: "acme/app"}, request, nil)
		if err == nil {
			response.Body.Close()
			t.Fatalf("Pull with %s was allowed", method)
		}
		if !errors.Is(err, ErrUnsupportedMethod) {
			t.Errorf("Pull with %s failed with %v, want %v", method, err, ErrUnsupportedMethod)
		}
		if upstream.method != "" {
			t.Errorf("Pull with %s reached the upstream as %s", method, upstream.method)
		}
	}
}

func TestClientRefusesEndpointsThatAreNotHosts(t *testing.T) {
	client := NewClient(http.DefaultClient)

	request := Request{Name: "acme/app", Kind: KindManifest, Reference: "1.2"}
	for endpoint, carrying := range map[string]string{"ghcr.io/acme": "a path", "https://ghcr.io": "a scheme"} {
		_, err := client.Pull(context.Background(), http.MethodGet,
			Upstream{Endpoint: endpoint, Repository: "acme/app"}, request, nil)
		if !errors.Is(err, ErrInvalidHost) {
			t.Errorf("Pull to a host carrying %s failed with %v, want %v", carrying, err, ErrInvalidHost)
		}
	}
}

// A token endpoint is a second host with its own certificate, so the exchange
// is asserted against a stub that records what it was asked for.
func newTokenEndpoint(t *testing.T, status int, body string) *recordingUpstream {
	t.Helper()
	endpoint := &recordingUpstream{}
	endpoint.server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		endpoint.method = r.Method
		endpoint.rawPath = r.URL.String()
		endpoint.header = r.Header.Clone()
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(endpoint.server.Close)
	return endpoint
}

func TestExchangeReturnsTheIssuedToken(t *testing.T) {
	endpoint := newTokenEndpoint(t, http.StatusOK, `{"token":"issued-for-the-pull","expires_in":300}`)
	challenge := Challenge{Scheme: SchemeBearer, Parameters: map[string]string{
		"realm":   "https://" + endpoint.endpoint() + "/token",
		"service": "ghcr.io",
	}}

	token, err := endpoint.client().Exchange(context.Background(), challenge, PullScope("acme/app"), nil)
	if err != nil {
		t.Fatalf("Exchange failed: %v", err)
	}
	if token.Value != "issued-for-the-pull" {
		t.Errorf("token = %q, want the issued one", token.Value)
	}
	if token.Lifetime() != 300*time.Second {
		t.Errorf("lifetime = %v, want 300s", token.Lifetime())
	}
	if !strings.Contains(endpoint.rawPath, "scope=repository%3Aacme%2Fapp%3Apull") {
		t.Errorf("token endpoint saw %q, want the pull scope", endpoint.rawPath)
	}
}

// Docker Hub fills access_token rather than the specified token field, so a
// client that reads only one of them works against ghcr and fails against
// Docker Hub — the exact shape of failure the endpoint mapping exists to avoid.
func TestExchangeAcceptsEitherTokenField(t *testing.T) {
	endpoint := newTokenEndpoint(t, http.StatusOK, `{"access_token":"docker-hub-token"}`)
	challenge := Challenge{Scheme: SchemeBearer, Parameters: map[string]string{
		"realm": "https://" + endpoint.endpoint() + "/token",
	}}

	token, err := endpoint.client().Exchange(context.Background(), challenge, PullScope("library/alpine"), nil)
	if err != nil {
		t.Fatalf("Exchange failed: %v", err)
	}
	if token.Value != "docker-hub-token" {
		t.Errorf("token = %q, want the access_token value", token.Value)
	}
	// A token endpoint that states no lifetime is read as the specification's
	// minimum rather than as "forever".
	if token.Lifetime() != 60*time.Second {
		t.Errorf("lifetime = %v, want the 60s default", token.Lifetime())
	}
}

func TestExchangeForwardsTheCredentialItIsGiven(t *testing.T) {
	endpoint := newTokenEndpoint(t, http.StatusOK, `{"token":"t"}`)
	challenge := Challenge{Scheme: SchemeBearer, Parameters: map[string]string{
		"realm": "https://" + endpoint.endpoint() + "/token",
	}}

	header := http.Header{"Authorization": {"Basic dXNlcjpwYXNz"}}
	if _, err := endpoint.client().Exchange(context.Background(), challenge, PullScope("acme/app"), header); err != nil {
		t.Fatalf("Exchange failed: %v", err)
	}
	if got := endpoint.header.Get("Authorization"); got != "Basic dXNlcjpwYXNz" {
		t.Errorf("token endpoint saw Authorization %q, want the supplied credential", got)
	}
}

// A refusal must not carry the rejected credential onward: the body a token
// endpoint answers with can repeat what it was sent.
func TestExchangeReportsARefusalWithoutItsBody(t *testing.T) {
	endpoint := newTokenEndpoint(t, http.StatusUnauthorized, `{"details":"bad password hunter2"}`)
	challenge := Challenge{Scheme: SchemeBearer, Parameters: map[string]string{
		"realm": "https://" + endpoint.endpoint() + "/token",
	}}

	_, err := endpoint.client().Exchange(context.Background(), challenge, PullScope("acme/app"), nil)
	if !errors.Is(err, ErrTokenRefused) {
		t.Fatalf("Exchange failed with %v, want %v", err, ErrTokenRefused)
	}
	if strings.Contains(err.Error(), "hunter2") {
		t.Errorf("the refusal carried the endpoint's body onward: %v", err)
	}
}

func TestExchangeRejectsABodyThatIsNotAToken(t *testing.T) {
	for _, body := range []string{`{"expires_in":300}`, `not json`} {
		endpoint := newTokenEndpoint(t, http.StatusOK, body)
		challenge := Challenge{Scheme: SchemeBearer, Parameters: map[string]string{
			"realm": "https://" + endpoint.endpoint() + "/token",
		}}

		if _, err := endpoint.client().Exchange(context.Background(), challenge, PullScope("acme/app"), nil); !errors.Is(err, ErrTokenRefused) {
			t.Errorf("Exchange of %q failed with %v, want %v", body, err, ErrTokenRefused)
		}
	}
}

// A token endpoint that cannot be reached is an outage, not a refusal: the two
// must stay apart so a caller is not told its credential was rejected.
func TestExchangeReportsATokenEndpointItCannotReach(t *testing.T) {
	endpoint := newTokenEndpoint(t, http.StatusOK, `{"token":"unused"}`)
	address := endpoint.endpoint()
	client := endpoint.client()
	endpoint.server.Close()

	challenge := Challenge{Scheme: SchemeBearer, Parameters: map[string]string{
		"realm": "https://" + address + "/token",
	}}
	_, err := client.Exchange(context.Background(), challenge, PullScope("acme/app"), nil)
	if err == nil {
		t.Fatal("Exchange against a closed endpoint succeeded")
	}
	if errors.Is(err, ErrTokenRefused) {
		t.Errorf("an unreachable endpoint was reported as a refusal: %v", err)
	}
}
