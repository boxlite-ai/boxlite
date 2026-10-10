// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package oci

import (
	"fmt"
	"net/url"
	"strings"
)

// SchemeBearer and SchemeBasic are the two challenge schemes a registry uses.
const (
	SchemeBearer = "bearer"
	SchemeBasic  = "basic"
)

// Challenge is a WWW-Authenticate challenge: how a registry states what it
// wants before it will answer.
type Challenge struct {
	// Scheme is lower-cased, because the header's scheme is case-insensitive
	// and registries do not agree on a spelling.
	Scheme string
	// Parameters are the challenge's directives, keyed lower-case. A Bearer
	// challenge carries realm and usually service; realm is the only one the
	// specification requires.
	Parameters map[string]string
}

// ParseChallenge reads one WWW-Authenticate challenge.
//
// Only the first challenge is read. Registries send one, and the header's
// grammar gives no way to tell which parameters belong to a second scheme
// without knowing every scheme's parameter set.
func ParseChallenge(header string) (Challenge, error) {
	scheme, rest, _ := strings.Cut(strings.TrimSpace(header), " ")
	if scheme == "" {
		return Challenge{}, fmt.Errorf("%w: %q names no scheme", ErrInvalidChallenge, header)
	}

	challenge := Challenge{Scheme: strings.ToLower(scheme), Parameters: map[string]string{}}
	for name, value := range parameters(rest) {
		challenge.Parameters[name] = value
	}
	return challenge, nil
}

// TokenURL is where a Bearer challenge says to exchange credentials for a
// token, scoped to one repository's pulls.
//
// The scope rides in the URL rather than being taken from the challenge: a
// challenge answered on the version-check endpoint carries no scope, and a
// token issued without one is good for nothing.
func (c Challenge) TokenURL(scope string) (*url.URL, error) {
	if c.Scheme != SchemeBearer {
		return nil, fmt.Errorf("%w: %q issues no tokens", ErrInvalidChallenge, c.Scheme)
	}
	realm, stated := c.Parameters["realm"]
	if !stated {
		return nil, fmt.Errorf("%w: a bearer challenge without a realm says where to go nowhere", ErrInvalidChallenge)
	}

	target, err := url.Parse(realm)
	if err != nil {
		return nil, fmt.Errorf("%w: realm %q is not a URL: %w", ErrInvalidChallenge, realm, err)
	}
	if target.Scheme != "https" {
		return nil, fmt.Errorf("%w: realm %q is not https, so credentials would go in the clear", ErrInvalidChallenge, realm)
	}

	query := target.Query()
	query.Set("scope", scope)
	if service, named := c.Parameters["service"]; named {
		query.Set("service", service)
	}
	target.RawQuery = query.Encode()
	return target, nil
}

// PullScope is the token scope that permits reading one repository.
func PullScope(repository string) string {
	return "repository:" + repository + ":pull"
}

// parameters walks `key="value"` and `key=value` pairs. It is a scanner rather
// than a split on commas because a quoted value may hold one — the pull scope
// of a push-capable token is `repository:x:pull,push`.
func parameters(rest string) map[string]string {
	found := map[string]string{}
	for len(rest) > 0 {
		rest = strings.TrimLeft(rest, " \t,")
		name, remainder, assigned := strings.Cut(rest, "=")
		if !assigned {
			break
		}
		name = strings.ToLower(strings.TrimSpace(name))

		var value string
		if strings.HasPrefix(remainder, `"`) {
			value, rest, assigned = strings.Cut(remainder[1:], `"`)
			if !assigned {
				break
			}
		} else {
			value, rest, _ = strings.Cut(remainder, ",")
			value = strings.TrimSpace(value)
		}
		if name != "" {
			found[name] = value
		}
	}
	return found
}
