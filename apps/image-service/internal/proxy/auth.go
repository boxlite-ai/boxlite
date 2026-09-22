// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
)

var (
	// ErrUnauthenticated means the caller did not present a credential the
	// control plane recognizes.
	ErrUnauthenticated = errors.New("unauthenticated")
	// ErrAuthUnavailable means the control plane could not be asked, so whether
	// the caller is a runner is simply unknown.
	ErrAuthUnavailable = errors.New("authentication unavailable")
)

// runnerAuthenticator answers one question: is this caller a runner, and which
// one?
//
// A runner's API key is an opaque column, not a signed token, so the answer can
// only come from the control plane. That makes the control plane part of the
// pull path, which is why both answers are cached — including the refusal. The
// registry proxy accepts connections from anywhere, so without a negative cache
// a caller repeating one bad key turns a request loop into an equal number of
// control-plane round trips. The cache is keyed by that key, so a caller that
// varies it each time still gets through to the control plane.
type runnerAuthenticator struct {
	api         *apiclient.APIClient
	verified    *ttlCache[string]
	rejected    *ttlCache[struct{}]
	positiveTTL time.Duration
	negativeTTL time.Duration
}

func newRunnerAuthenticator(api *apiclient.APIClient, positiveTTL, negativeTTL time.Duration) *runnerAuthenticator {
	return &runnerAuthenticator{
		api:         api,
		verified:    newTTLCache[string](maxCacheEntries),
		rejected:    newTTLCache[struct{}](maxCacheEntries),
		positiveTTL: positiveTTL,
		negativeTTL: negativeTTL,
	}
}

// authenticate returns the id of the runner the key belongs to.
//
// When the control plane cannot be reached, a cached answer still serves: a
// pull already under way must not fail because the control plane is restarting.
// An uncached caller is refused with ErrAuthUnavailable rather than admitted,
// because the alternative is to let anyone in whenever the control plane is
// down.
func (a *runnerAuthenticator) authenticate(ctx context.Context, apiKey string) (string, error) {
	if apiKey == "" {
		return "", fmt.Errorf("%w: no credential presented", ErrUnauthenticated)
	}
	key := credentialKey(apiKey)

	if runnerID, known := a.verified.get(key); known {
		return runnerID, nil
	}
	if _, known := a.rejected.get(key); known {
		return "", fmt.Errorf("%w: credential was refused", ErrUnauthenticated)
	}

	runner, response, err := a.api.RunnersAPI.
		GetInfoForAuthenticatedRunner(context.WithValue(ctx, apiclient.ContextAccessToken, apiKey)).
		Execute()
	switch {
	case response == nil:
		// No answer at all: the control plane is unreachable, which is not the
		// same as a refusal and must not be recorded as one. Checked before the
		// status cases rather than alongside the error, because a caller has to
		// be refused either way and a nil dereference here would take the
		// process down instead.
		return "", fmt.Errorf("%w: %w", ErrAuthUnavailable, err)
	case response.StatusCode == http.StatusUnauthorized, response.StatusCode == http.StatusForbidden:
		a.rejected.put(key, struct{}{}, a.negativeTTL)
		return "", fmt.Errorf("%w: control plane refused the credential", ErrUnauthenticated)
	case err != nil:
		return "", fmt.Errorf("%w: control plane answered %s", ErrAuthUnavailable, response.Status)
	case runner == nil || runner.Id == "":
		return "", fmt.Errorf("%w: control plane named no runner", ErrAuthUnavailable)
	}

	a.verified.put(key, runner.Id, a.positiveTTL)
	return runner.Id, nil
}

// credentialKey is what the caches are keyed by, so a credential is not itself
// a map key held for its whole lifetime.
func credentialKey(apiKey string) string {
	sum := sha256.Sum256([]byte(apiKey))
	return hex.EncodeToString(sum[:])
}
