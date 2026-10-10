// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/image-service/internal/secrets"
)

var (
	// ErrCredentialUnavailable means an organization's registry login could
	// not be found or read right now, which is not the same as it having none.
	ErrCredentialUnavailable = errors.New("registry credential unavailable")
	// ErrLoginNotPermitted means the control plane will not give this runner
	// the organization's login: it hosts no box of that organization.
	ErrLoginNotPermitted = errors.New("registry credential not permitted")
)

// organizationID is the shape of an organization's id. A path naming anything
// else names no organization, so it has no login to look up and is pulled
// anonymously, as every pull was before logins existed.
var organizationID = regexp.MustCompile(`^(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// registryLogin is what an organization registered for one upstream repository.
type registryLogin struct {
	username string
	password string
}

// credentialFinder resolves the login a pull presents upstream.
//
// Two steps, from two places. The control plane says which login applies and
// where its password is kept; Secret Manager holds the password, readable by
// this process and not by the control plane. Only the first answer is cached:
// the password is read each time a token is exchanged, which the token cache
// already makes rare.
type credentialFinder struct {
	api     *apiclient.APIClient
	secrets secrets.Reader
	found   *ttlCache[foundCredential]
	ttl     time.Duration
}

// foundCredential is the control plane's answer, including "none" and "not
// for this runner".
type foundCredential struct {
	none          bool
	forbidden     bool
	username      string
	secretVersion string
}

// newCredentialFinder returns nil when there is no secret store, and a nil
// finder finds nothing: every pull is then anonymous, as before credentials.
func newCredentialFinder(api *apiclient.APIClient, reader secrets.Reader, ttl time.Duration) *credentialFinder {
	if reader == nil {
		return nil
	}
	return &credentialFinder{api: api, secrets: reader, found: newTTLCache[foundCredential](maxCacheEntries), ttl: ttl}
}

// find returns the login for this pull, or nil when the organization has none.
//
// It asks as the runner, with the key the runner presented here: the control
// plane answers only runners, and gives a runner an organization's login only
// when the runner hosts a box of it. So the answer is cached per runner, a
// refusal included, and the token broker keeps its tokens per runner as well.
// Caching the refusal delays nothing real: a runner pulls for an organization
// once it has been given one of its boxes, so one refused has no box to wait
// for.
func (f *credentialFinder) find(ctx context.Context, from caller, org, host, repository string) (*registryLogin, error) {
	if f == nil || !organizationID.MatchString(org) {
		return nil, nil
	}
	key := from.runnerID + "\x00" + org + "\x00" + host + "\x00" + repository
	refresh := func() (foundCredential, error) {
		found, err := f.ask(ctx, from.apiKey, org, host, repository)
		if err == nil {
			f.found.put(key, found, f.ttl)
		}
		return found, err
	}

	found, known := f.found.get(key)
	if !known {
		var err error
		if found, err = refresh(); err != nil {
			return nil, err
		}
	}
	login, err := f.loginFrom(ctx, org, found)
	if !known || !errors.Is(err, ErrCredentialUnavailable) {
		return login, err
	}
	// A remembered answer whose password cannot be read may name a version
	// destroyed since: the login was removed, or replaced to rotate its
	// password, which has no other way to happen. Ask once more rather than
	// fail every pull until the answer expires.
	if found, err = refresh(); err != nil {
		return nil, err
	}
	return f.loginFrom(ctx, org, found)
}

// loginFrom turns the control plane's answer into the login to present,
// reading the password it names.
func (f *credentialFinder) loginFrom(ctx context.Context, org string, found foundCredential) (*registryLogin, error) {
	if found.forbidden {
		return nil, fmt.Errorf("%w: organization %s", ErrLoginNotPermitted, org)
	}
	if found.none {
		return nil, nil
	}

	password, err := f.secrets.Read(ctx, found.secretVersion)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrCredentialUnavailable, err)
	}
	return &registryLogin{username: found.username, password: password}, nil
}

func (f *credentialFinder) ask(ctx context.Context, apiKey string, org, host, repository string) (foundCredential, error) {
	credential, response, err := f.api.RunnersAPI.
		GetRegistryCredentialForAuthenticatedRunner(context.WithValue(ctx, apiclient.ContextAccessToken, apiKey)).
		OrganizationId(org).
		Host(host).
		Repository(repository).
		Execute()
	switch {
	case response == nil:
		return foundCredential{}, fmt.Errorf("%w: %w", ErrCredentialUnavailable, err)
	case response.StatusCode == http.StatusNotFound:
		return foundCredential{none: true}, nil
	case response.StatusCode == http.StatusForbidden:
		return foundCredential{forbidden: true}, nil
	case err != nil:
		return foundCredential{}, fmt.Errorf("%w: control plane answered %s", ErrCredentialUnavailable, response.Status)
	case credential == nil || credential.SecretVersion == "":
		return foundCredential{}, fmt.Errorf("%w: control plane named no secret", ErrCredentialUnavailable)
	case credential.Kind != apiclient.REGISTRYCREDENTIALKIND_BASIC:
		return foundCredential{}, fmt.Errorf("%w: kind %q is not one this proxy speaks", ErrCredentialUnavailable, credential.Kind)
	}
	return foundCredential{username: credential.Username, secretVersion: credential.SecretVersion}, nil
}
