// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
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
	username      string
	password      string
	secretVersion string
}

// credentialFinder resolves the login a pull presents upstream.
//
// Two steps, from two places. The control plane says which login applies and
// where its password is kept; Secret Manager holds the password, readable by
// this process and not by the control plane. Positive metadata is read before
// every pull so rotation stops old bearer reuse across proxy replicas. Passwords
// are read only when a token must be exchanged; negative lookups keep their TTL.
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

// lookup resolves the current secret version without reading its password.
//
// It asks as the runner, with the key the runner presented here: the control
// plane answers only runners, and gives a runner an organization's login only
// when the runner hosts a box of it. Negative answers and bearer tokens are
// scoped per runner; positive metadata is checked on every request.
// Caching the refusal delays nothing real: a runner pulls for an organization
// once it has been given one of its boxes, so one refused has no box to wait
// for.
func (f *credentialFinder) lookup(ctx context.Context, from caller, org, host, repository string) (foundCredential, error) {
	if f == nil || !organizationID.MatchString(org) {
		return foundCredential{none: true}, nil
	}
	key := from.runnerID + "\x00" + org + "\x00" + host + "\x00" + repository
	found, known := f.found.get(key)
	if !known {
		var err error
		if found, err = f.ask(ctx, from.apiKey, org, host, repository); err != nil {
			return foundCredential{}, err
		}
		if found.none || found.forbidden {
			f.found.put(key, found, f.ttl)
		}
	}
	if found.forbidden {
		return foundCredential{}, fmt.Errorf("%w: organization %s", ErrLoginNotPermitted, org)
	}
	return found, nil
}

// loginFrom turns the control plane's answer into the login to present,
// reading the password it names.
func (f *credentialFinder) loginFrom(ctx context.Context, found foundCredential) (*registryLogin, error) {
	if found.none {
		return nil, nil
	}

	password, err := f.secrets.Read(ctx, found.secretVersion)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrCredentialUnavailable, err)
	}
	return &registryLogin{username: found.username, password: password, secretVersion: found.secretVersion}, nil
}

func (f *credentialFinder) ask(ctx context.Context, apiKey string, org, host, repository string) (foundCredential, error) {
	// This proxy-only operation is deliberately absent from the customer SDK.
	config := f.api.GetConfig()
	baseURL, err := config.ServerURLWithContext(ctx, "")
	if err != nil {
		return foundCredential{}, fmt.Errorf("%w: %w", ErrCredentialUnavailable, err)
	}
	endpoint, err := url.Parse(baseURL)
	if err != nil {
		return foundCredential{}, fmt.Errorf("%w: %w", ErrCredentialUnavailable, err)
	}
	endpoint = endpoint.JoinPath("runners/me/images/registry-credentials")
	query := endpoint.Query()
	query.Set("organizationId", org)
	query.Set("host", host)
	query.Set("repository", repository)
	endpoint.RawQuery = query.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return foundCredential{}, fmt.Errorf("%w: %w", ErrCredentialUnavailable, err)
	}
	for name, value := range config.DefaultHeader {
		request.Header.Set(name, value)
	}
	request.Header.Set("User-Agent", config.UserAgent)
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+apiKey)
	response, err := config.HTTPClient.Do(request)
	if err != nil {
		return foundCredential{}, fmt.Errorf("%w: %w", ErrCredentialUnavailable, err)
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case http.StatusNotFound:
		return foundCredential{none: true}, nil
	case http.StatusForbidden:
		return foundCredential{forbidden: true}, nil
	case http.StatusOK:
	default:
		return foundCredential{}, fmt.Errorf("%w: control plane answered %s", ErrCredentialUnavailable, response.Status)
	}
	var credential struct {
		Kind          string  `json:"kind"`
		Username      *string `json:"username"`
		SecretVersion string  `json:"secretVersion"`
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return foundCredential{}, fmt.Errorf("%w: %w", ErrCredentialUnavailable, err)
	}
	if err := json.Unmarshal(body, &credential); err != nil || credential.Username == nil {
		return foundCredential{}, fmt.Errorf("%w: invalid credential response", ErrCredentialUnavailable)
	}
	if credential.SecretVersion == "" {
		return foundCredential{}, fmt.Errorf("%w: control plane named no secret", ErrCredentialUnavailable)
	}
	if credential.Kind != "basic" {
		return foundCredential{}, fmt.Errorf("%w: kind %q is not one this proxy speaks", ErrCredentialUnavailable, credential.Kind)
	}
	return foundCredential{username: *credential.Username, secretVersion: credential.SecretVersion}, nil
}
