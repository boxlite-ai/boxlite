// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

/*
Google ID tokens for an OTLP endpoint that authorises by caller.

The collector is a Cloud Run service with internal ingress *and* an invoker
list, and those are two independent doors: internal ingress decides where a
request may come from, `roles/run.invoker` decides who may make it. The second
one is enforced per request against a Google ID token, so a client on the
allow-list that sends no token is answered 403 by Google's own front end —
before the collector sees a byte. That is the failure this file removes: every
runner and proxy on the GCP path was on the invoker list and still exporting
nothing.

`OTEL_EXPORTER_OTLP_HEADERS` cannot carry it. A header is a static string and an
ID token expires within the hour, so a token pasted there turns a permanent 403
into one that returns an hour later — the same outage, harder to find. It has to
be fetched per request from a source that refreshes, which is what this is.

Stdlib only, deliberately. The token is one HTTP GET against the metadata
server, and `apps/infra/mdeploy/stack/providers/gcp/runners.ts` already reaches
it the same way for the host's own address; a Google SDK would pull a large
dependency tree into a binary that ships to every runner for the sake of one
request.

Nothing here activates on AWS: the audience is empty unless a GCP stage set it,
and an empty audience leaves the exporter's transport untouched.
*/

package telemetry

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Where a GCE instance asks for a token minted for one audience. `full`
// includes the instance's own details in the claims, which is what makes an
// audit trail say which host exported.
//
// A var rather than a const so a test can point it at a server it controls —
// otherwise the only way to exercise the fetch is to run inside GCE, and the
// parts worth checking (the required header, a non-200, an answer that arrives
// in more than one read) would all go untested.
var metadataIdentityURL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity"

const (
	// How long before expiry a token is replaced. A batch that starts just
	// under the wire must not finish just over it, and the metadata server
	// serves a cached token cheaply, so the margin is generous rather than tight.
	idTokenRefreshMargin = 5 * time.Minute

	// The metadata server is link-local; a request that hangs here would stall
	// an export batch, and the exporter has its own retry.
	idTokenFetchTimeout = 10 * time.Second

	// A generous ceiling on the answer. A `format=full` ID token is well under
	// this; anything larger is an error page, not a credential.
	maxIDTokenBytes = 64 << 10
)

/*
A transport that attaches a Google ID token, refreshed before it expires.

Wrapping rather than replacing the exporter's own transport: the exporter sets
TLS and timeouts it needs, and this only adds a header.
*/
type googleIDTokenTransport struct {
	audience string
	base     http.RoundTripper
	// The metadata server itself, injectable so a test never depends on
	// running inside GCE.
	fetch func(audience string) (string, error)

	mu      sync.Mutex
	token   string
	expires time.Time
}

/*
An HTTP client whose requests carry an ID token for `audience`.

The audience is the collector's base URL: Cloud Run validates the token's `aud`
against the service's own address, so appending `/v1/traces` here would mint a
token for something that does not exist and the 403 would look identical.
*/
func newGoogleIDTokenClient(audience string, base *http.Client) *http.Client {
	underlying := http.DefaultTransport
	client := &http.Client{}
	if base != nil {
		*client = *base
		if base.Transport != nil {
			underlying = base.Transport
		}
	}
	client.Transport = &googleIDTokenTransport{audience: audience, base: underlying, fetch: fetchMetadataIDToken}
	return client
}

func (t *googleIDTokenTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	token, err := t.current()
	if err != nil {
		// Returned rather than swallowed: an export that silently went out
		// unauthenticated would be answered 403 anyway, and the error naming
		// the token is the one a person can act on.
		return nil, fmt.Errorf("otlp: could not obtain a Google ID token for %s: %w", t.audience, err)
	}
	// Cloned because a RoundTripper must not modify the request it is given —
	// the exporter retries the same one.
	authorized := request.Clone(request.Context())
	authorized.Header.Set("Authorization", "Bearer "+token)
	return t.base.RoundTrip(authorized)
}

// current returns the cached token, or a fresh one when it is missing or close
// to expiry.
func (t *googleIDTokenTransport) current() (string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()

	if t.token != "" && time.Until(t.expires) > idTokenRefreshMargin {
		return t.token, nil
	}

	token, err := t.fetch(t.audience)
	if err != nil {
		return "", err
	}
	expires, err := idTokenExpiry(token)
	if err != nil {
		// The token is usable even when its expiry cannot be read, so this is
		// not fatal — but it must not be cached, or an unreadable expiry would
		// pin one token forever.
		return token, nil
	}
	t.token, t.expires = token, expires
	return token, nil
}

// fetchMetadataIDToken makes one GET against the metadata server, which answers
// with the raw JWT.
func fetchMetadataIDToken(audience string) (string, error) {
	request, err := http.NewRequest(http.MethodGet, metadataIdentityURL+"?format=full&audience="+url.QueryEscape(audience), nil)
	if err != nil {
		return "", err
	}
	// What distinguishes a real request from a browser that wandered onto the
	// address. The server refuses one without it.
	request.Header.Set("Metadata-Flavor", "Google")

	answer, err := (&http.Client{Timeout: idTokenFetchTimeout}).Do(request)
	if err != nil {
		return "", err
	}
	defer answer.Body.Close()

	// Read in full rather than into a fixed buffer: one `Read` may return fewer
	// bytes than are waiting, and a JWT truncated mid-signature is refused with
	// the same 403 as no token — indistinguishable in the logs. Bounded because
	// the body is whatever answered, not necessarily a token.
	body, err := io.ReadAll(io.LimitReader(answer.Body, maxIDTokenBytes))
	if err != nil {
		return "", fmt.Errorf("reading the metadata server's answer: %w", err)
	}
	token := strings.TrimSpace(string(body))
	if answer.StatusCode != http.StatusOK {
		// The body is an error page here, not a token, so it is not echoed:
		// on the success path these same bytes are a credential.
		return "", fmt.Errorf("metadata server answered %d", answer.StatusCode)
	}
	if token == "" {
		return "", fmt.Errorf("metadata server answered 200 with no token")
	}
	return token, nil
}

// idTokenExpiry reads when a JWT stops being accepted from its own `exp` claim.
//
// The signature is not verified and does not need to be: this is the holder
// reading its own credential to decide when to replace it, not a server
// deciding whether to trust one.
func idTokenExpiry(token string) (time.Time, error) {
	segments := strings.Split(token, ".")
	if len(segments) != 3 {
		return time.Time{}, fmt.Errorf("not a JWT: %d segments", len(segments))
	}
	payload, err := base64.RawURLEncoding.DecodeString(segments[1])
	if err != nil {
		return time.Time{}, fmt.Errorf("payload is not base64url: %w", err)
	}
	var claims struct {
		Exp int64 `json:"exp"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return time.Time{}, fmt.Errorf("payload is not JSON: %w", err)
	}
	if claims.Exp == 0 {
		return time.Time{}, fmt.Errorf("payload carries no exp")
	}
	return time.Unix(claims.Exp, 0), nil
}
