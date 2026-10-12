// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"net/http"

	"github.com/boxlite-ai/image-service/internal/oci"
)

// tokenBroker holds the short-lived bearers upstream registries issue.
//
// Keyed by organization as well as upstream and scope, although every token it
// holds today is anonymous and an organization's token would serve any other.
// The key is what stops that from being true later: once an organization's own
// credential buys the token, sharing one across organizations would hand out
// access nobody granted.
type tokenBroker struct {
	client *oci.Client
	tokens *ttlCache[string]
}

func newTokenBroker(client *oci.Client) *tokenBroker {
	return &tokenBroker{client: client, tokens: newTTLCache[string](maxCacheEntries)}
}

// cached returns a bearer already held for this pull, if any.
func (b *tokenBroker) cached(org string, upstream oci.Upstream) (string, bool) {
	return b.tokens.get(tokenKey(org, upstream))
}

// acquire answers the challenge an upstream just made and remembers the result.
//
// The exchange is anonymous: this release stores no registry credentials, so
// the only images it can reach are the ones the upstream serves to anyone. The
// organization's own credential joins the exchange here when it exists.
func (b *tokenBroker) acquire(ctx context.Context, org string, upstream oci.Upstream, header string) (string, error) {
	challenge, err := oci.ParseChallenge(header)
	if err != nil {
		return "", err
	}
	if challenge.Scheme != oci.SchemeBearer {
		// Basic, or something nobody here speaks. Either way there is no token
		// to fetch, and without a credential there is nothing to send.
		return "", nil
	}

	token, err := b.client.Exchange(ctx, challenge, oci.PullScope(upstream.Repository), nil)
	if err != nil {
		return "", err
	}
	b.tokens.put(tokenKey(org, upstream), token.Value, token.Lifetime())
	return token.Value, nil
}

// tokenKey is (organization, upstream endpoint, repository). The repository is
// the scope: a token issued for one repository is refused for every other, so a
// key without it would hand out a bearer that cannot work.
func tokenKey(org string, upstream oci.Upstream) string {
	return org + "\x00" + upstream.Endpoint + "\x00" + upstream.Repository
}

// bearer returns the Authorization header value for a token, or nothing at all
// when there is no token: an empty header is how an anonymous pull is spelled.
func bearer(token string) http.Header {
	if token == "" {
		return nil
	}
	return http.Header{"Authorization": {"Bearer " + token}}
}
