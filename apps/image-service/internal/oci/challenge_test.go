// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package oci

import (
	"errors"
	"testing"
)

func TestParseChallengeReadsWhatARegistryAsksFor(t *testing.T) {
	cases := []struct {
		name       string
		header     string
		scheme     string
		parameters map[string]string
	}{
		{
			name:   "ghcr",
			header: `Bearer realm="https://ghcr.io/token",service="ghcr.io"`,
			scheme: SchemeBearer,
			parameters: map[string]string{
				"realm":   "https://ghcr.io/token",
				"service": "ghcr.io",
			},
		},
		{
			name:   "docker hub",
			header: `Bearer realm="https://auth.docker.io/token",service="registry.docker.io"`,
			scheme: SchemeBearer,
			parameters: map[string]string{
				"realm":   "https://auth.docker.io/token",
				"service": "registry.docker.io",
			},
		},
		{
			// A scope naming several actions holds a comma inside its quotes,
			// so a parser that splits the header on commas loses the rest of
			// the challenge from here on.
			name:   "a scope containing a comma",
			header: `Bearer realm="https://ghcr.io/token",scope="repository:acme/app:pull,push",service="ghcr.io"`,
			scheme: SchemeBearer,
			parameters: map[string]string{
				"realm":   "https://ghcr.io/token",
				"scope":   "repository:acme/app:pull,push",
				"service": "ghcr.io",
			},
		},
		{
			name:       "basic",
			header:     `Basic realm="boxlite-registry-proxy"`,
			scheme:     SchemeBasic,
			parameters: map[string]string{"realm": "boxlite-registry-proxy"},
		},
		{
			// The scheme is case-insensitive and registries do not agree.
			name:       "an unquoted value and an odd case",
			header:     `BEARER realm=https://ghcr.io/token`,
			scheme:     SchemeBearer,
			parameters: map[string]string{"realm": "https://ghcr.io/token"},
		},
		{
			name:       "a scheme with no parameters",
			header:     `Negotiate`,
			scheme:     "negotiate",
			parameters: map[string]string{},
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got, err := ParseChallenge(testCase.header)
			if err != nil {
				t.Fatalf("ParseChallenge(%q) failed: %v", testCase.header, err)
			}
			if got.Scheme != testCase.scheme {
				t.Errorf("scheme = %q, want %q", got.Scheme, testCase.scheme)
			}
			if len(got.Parameters) != len(testCase.parameters) {
				t.Errorf("parameters = %v, want %v", got.Parameters, testCase.parameters)
			}
			for name, want := range testCase.parameters {
				if got.Parameters[name] != want {
					t.Errorf("parameter %q = %q, want %q", name, got.Parameters[name], want)
				}
			}
		})
	}
}

func TestParseChallengeRejectsAnEmptyHeader(t *testing.T) {
	if _, err := ParseChallenge("   "); !errors.Is(err, ErrInvalidChallenge) {
		t.Errorf("ParseChallenge(blank) failed with %v, want %v", err, ErrInvalidChallenge)
	}
}

// The scope is what makes a token usable: one issued without it is accepted by
// the token endpoint and then refused by every pull.
func TestTokenURLCarriesTheScopeAndService(t *testing.T) {
	challenge, err := ParseChallenge(`Bearer realm="https://ghcr.io/token",service="ghcr.io"`)
	if err != nil {
		t.Fatalf("ParseChallenge failed: %v", err)
	}

	target, err := challenge.TokenURL(PullScope("acme/app"))
	if err != nil {
		t.Fatalf("TokenURL failed: %v", err)
	}
	if want := "https://ghcr.io/token?scope=repository%3Aacme%2Fapp%3Apull&service=ghcr.io"; target.String() != want {
		t.Errorf("TokenURL = %q, want %q", target.String(), want)
	}
}

func TestTokenURLRefusesChallengesItCannotAnswer(t *testing.T) {
	cases := []struct {
		name   string
		header string
	}{
		{"basic issues no tokens", `Basic realm="registry"`},
		{"bearer without a realm", `Bearer service="ghcr.io"`},
		{"a realm that is not a URL", `Bearer realm="://"`},
		{"a realm in the clear", `Bearer realm="http://ghcr.io/token"`},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			challenge, err := ParseChallenge(testCase.header)
			if err != nil {
				t.Fatalf("ParseChallenge failed: %v", err)
			}
			if target, err := challenge.TokenURL(PullScope("acme/app")); !errors.Is(err, ErrInvalidChallenge) {
				t.Errorf("TokenURL = %v, %v; want %v", target, err, ErrInvalidChallenge)
			}
		})
	}
}

// A registry that sends a parameter without a value, or a quoted value it never
// closes, has sent something this parser cannot read past. Stopping there keeps
// what came before and never invents a realm out of the rest.
func TestParseChallengeStopsAtAParameterItCannotRead(t *testing.T) {
	for header, want := range map[string]map[string]string{
		`Bearer service="ghcr.io",realm`:                  {"service": "ghcr.io"},
		`Bearer service="ghcr.io",realm="https://ghcr.io`: {"service": "ghcr.io"},
	} {
		challenge, err := ParseChallenge(header)
		if err != nil {
			t.Errorf("ParseChallenge(%q) failed: %v", header, err)
			continue
		}
		if len(challenge.Parameters) != len(want) || challenge.Parameters["service"] != want["service"] {
			t.Errorf("ParseChallenge(%q).Parameters = %v, want %v", header, challenge.Parameters, want)
		}
	}
}
