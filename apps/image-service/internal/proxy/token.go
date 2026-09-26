// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"time"

	"github.com/boxlite-ai/image-service/internal/oci"
)

// credentialedTokenLifetime caps how long a token bought with an
// organization's own login is reused.
//
// The cache is the revocation delay. A login the organization deletes or
// rotates keeps working here until its token expires, and the control plane has
// no way to tell this process to forget one. gcr.io states twelve hours; five
// minutes still covers a manifest and every layer of one pull. An anonymous
// token is not capped: there is nothing to revoke.
const credentialedTokenLifetime = 5 * time.Minute

// ErrRealmRefused means a registry named a token endpoint this proxy will not
// send an organization's login to.
var ErrRealmRefused = errors.New("token endpoint refused for a login")

// tokenHostsBeyond names the hosts a registry's token endpoint may sit on
// other than the registry itself. Docker Hub's is `auth.docker.io`; ghcr.io,
// quay.io and gcr.io each issue tokens from their own host.
//
// A login goes nowhere else. The challenge that names a token endpoint is the
// registry's own answer and arrives over verified TLS, but it is still text an
// upstream chose, and a password is not something to send wherever that text
// points. An anonymous exchange is not held to this: it carries nothing.
var tokenHostsBeyond = map[string][]string{"registry-1.docker.io": {"auth.docker.io"}}

// checkRealm refuses a token endpoint that is neither the registry's own host
// nor one it is known to use.
func checkRealm(challenge oci.Challenge, upstream oci.Upstream) error {
	realm, err := url.Parse(challenge.Parameters["realm"])
	if err != nil {
		return fmt.Errorf("%w: realm is not a URL: %w", ErrRealmRefused, err)
	}
	if realm.Host == upstream.Endpoint || slices.Contains(tokenHostsBeyond[upstream.Endpoint], realm.Host) {
		return nil
	}
	return fmt.Errorf("%w: %s named %s", ErrRealmRefused, upstream.Endpoint, realm.Host)
}

// tokenBroker holds the short-lived bearers upstream registries issue.
//
// Keyed by organization as well as upstream and scope, because an
// organization's own login buys some of them, and sharing one of those across
// organizations would hand out access nobody granted. Keyed by runner too, for
// the same reason one step down: a runner is given an organization's login
// only while it hosts a box of that organization, and a token that login
// bought for one runner would otherwise serve any other runner's pull of the
// same path without that question being asked.
type tokenBroker struct {
	client *oci.Client
	tokens *ttlCache[string]
}

func newTokenBroker(client *oci.Client) *tokenBroker {
	return &tokenBroker{client: client, tokens: newTTLCache[string](maxCacheEntries)}
}

// cached returns a bearer already held for this runner's pull, if any.
func (b *tokenBroker) cached(runnerID, org string, upstream oci.Upstream) (string, bool) {
	return b.tokens.get(tokenKey(runnerID, org, upstream))
}

// acquire answers the challenge an upstream just made and remembers the result.
//
// With a login, the exchange presents it and the token it buys reaches what
// the organization can see. Without one it is anonymous, and reaches only what
// the upstream serves to anyone.
func (b *tokenBroker) acquire(
	ctx context.Context,
	runnerID string,
	org string,
	upstream oci.Upstream,
	header string,
	login *registryLogin,
) (string, error) {
	challenge, err := oci.ParseChallenge(header)
	if err != nil {
		return "", err
	}
	if challenge.Scheme != oci.SchemeBearer {
		// Basic, or something nobody here speaks. Every registry a login is
		// accepted for answers Bearer, so there is no token to fetch.
		return "", nil
	}
	if login != nil {
		if err := checkRealm(challenge, upstream); err != nil {
			return "", err
		}
	}

	token, err := b.client.Exchange(ctx, challenge, oci.PullScope(upstream.Repository), basicAuth(login))
	if err != nil {
		return "", err
	}
	lifetime := token.Lifetime()
	if login != nil && lifetime > credentialedTokenLifetime {
		lifetime = credentialedTokenLifetime
	}
	b.tokens.put(tokenKey(runnerID, org, upstream), token.Value, lifetime)
	return token.Value, nil
}

// basicAuth is how a login is presented to a token endpoint, or nothing at all
// for an anonymous exchange.
func basicAuth(login *registryLogin) http.Header {
	if login == nil {
		return nil
	}
	request := http.Request{Header: http.Header{}}
	request.SetBasicAuth(login.username, login.password)
	return request.Header
}

// tokenKey is (runner, organization, upstream endpoint, repository). The
// repository is the scope: a token issued for one repository is refused for
// every other, so a key without it would hand out a bearer that cannot work.
func tokenKey(runnerID, org string, upstream oci.Upstream) string {
	return runnerID + "\x00" + org + "\x00" + upstream.Endpoint + "\x00" + upstream.Repository
}

// bearer returns the Authorization header value for a token, or nothing at all
// when there is no token: an empty header is how an anonymous pull is spelled.
func bearer(token string) http.Header {
	if token == "" {
		return nil
	}
	return http.Header{"Authorization": {"Bearer " + token}}
}
