// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package oci

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
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
	// setting.
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
