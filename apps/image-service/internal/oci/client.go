// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package oci

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// Client issues distribution pulls against upstream registries.
type Client struct {
	httpClient *http.Client
}

// NewClient returns a Client that issues its requests with httpClient.
//
// Every policy that client carries — timeouts, redirect handling, TLS — stays
// with the caller, because each of them is a decision about who may be talked
// to, and this package has no standing to make those.
func NewClient(httpClient *http.Client) *Client {
	return &Client{httpClient: httpClient}
}

// Pull issues one pull and returns the upstream response untouched: its status,
// its headers, and a body nobody has read.
//
// Untouched is the point. The digest a client verifies covers the manifest
// bytes exactly as the upstream served them, so anything that decodes and
// re-encodes on the way through breaks it. The caller closes the body.
//
// The upstream is addressed by upstream.Repository, never by request.Name: the
// name that arrived may carry routing segments the upstream has never heard of.
func (c *Client) Pull(ctx context.Context, method string, upstream Upstream, request Request, header http.Header) (*http.Response, error) {
	if method != http.MethodGet && method != http.MethodHead {
		return nil, fmt.Errorf("%w: %s cannot pull", ErrUnsupportedMethod, method)
	}
	if err := checkHost(upstream.Endpoint); err != nil {
		return nil, err
	}
	path := PullPath(upstream.Repository, request.Kind, request.Reference)
	return c.do(ctx, method, upstream.Endpoint, path, header)
}

func (c *Client) do(ctx context.Context, method, endpoint, path string, header http.Header) (*http.Response, error) {
	// A registry that does not serve TLS is a registry whose answers cannot be
	// trusted to be its own, and nothing here needs one, so the scheme is not a
	// setting. This covers the request composed here only: a redirect goes
	// where the registry says, and what judges that hop is the caller's address
	// rule and the digest the puller checks.
	target := &url.URL{Scheme: "https", Host: endpoint, Path: path}
	request, err := http.NewRequestWithContext(ctx, method, target.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("build %s %s: %w", method, target.Redacted(), err)
	}
	for name, values := range header {
		for _, value := range values {
			request.Header.Add(name, value)
		}
	}

	response, err := c.httpClient.Do(request)
	if err != nil {
		// url.Error already carries the target, and it is the caller's own
		// header that may hold a credential, so nothing is added here.
		return nil, err
	}
	return response, nil
}

// Token is a short-lived bearer a registry issues for one scope.
type Token struct {
	Value string
	// ExpiresIn is the lifetime the token endpoint stated, in seconds. Zero
	// means it stated none, which the specification reads as 60.
	ExpiresIn int
}

// defaultTokenLifetime is what the specification says to assume when a token
// endpoint omits expires_in.
const defaultTokenLifetime = 60 * time.Second

// Lifetime is how long the token may be reused.
func (t Token) Lifetime() time.Duration {
	if t.ExpiresIn <= 0 {
		return defaultTokenLifetime
	}
	return time.Duration(t.ExpiresIn) * time.Second
}

// Exchange answers a Bearer challenge, returning a token good for scope.
//
// Whatever credential the exchange needs arrives in header; this package sends
// what it is handed and does not know whose credential it is or where it came
// from.
func (c *Client) Exchange(ctx context.Context, challenge Challenge, scope string, header http.Header) (Token, error) {
	target, err := challenge.TokenURL(scope)
	if err != nil {
		return Token{}, err
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return Token{}, fmt.Errorf("build token request: %w", err)
	}
	for name, values := range header {
		for _, value := range values {
			request.Header.Add(name, value)
		}
	}

	response, err := c.httpClient.Do(request)
	if err != nil {
		return Token{}, err
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		// The body may repeat the credential that was rejected, so only the
		// status travels on.
		return Token{}, fmt.Errorf("%w: %s answered %s", ErrTokenRefused, target.Redacted(), response.Status)
	}

	// Registries disagree on the field: the specification says token, and
	// Docker Hub also fills access_token. Read both and prefer the specified one.
	var issued struct {
		Token       string `json:"token"`
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, tokenResponseLimit)).Decode(&issued); err != nil {
		return Token{}, fmt.Errorf("%w: %s answered a body that is not a token: %w", ErrTokenRefused, target.Redacted(), err)
	}

	value := issued.Token
	if value == "" {
		value = issued.AccessToken
	}
	if value == "" {
		return Token{}, fmt.Errorf("%w: %s answered without a token", ErrTokenRefused, target.Redacted())
	}
	return Token{Value: value, ExpiresIn: issued.ExpiresIn}, nil
}

// tokenResponseLimit caps the token document. It is a small JSON object, and an
// endpoint that answers with something unbounded should not be read into memory
// on its say-so.
const tokenResponseLimit = 1 << 20
