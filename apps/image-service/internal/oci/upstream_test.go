// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package oci

import (
	"errors"
	"testing"
)

// The Docker Hub mapping is the one a proxy cannot skip: docker.io serves the
// website, so a pull that keeps the published host fails for every Docker Hub
// image while every other registry keeps working.
func TestResolveUpstreamSendsDockerHubToItsRegistryEndpoint(t *testing.T) {
	cases := []struct {
		name       string
		host       string
		repository string
		want       Upstream
	}{
		{
			name:       "docker.io implies the library namespace",
			host:       "docker.io",
			repository: "alpine",
			want:       Upstream{Endpoint: "registry-1.docker.io", Repository: "library/alpine"},
		},
		{
			name:       "an explicit namespace is left alone",
			host:       "docker.io",
			repository: "acme/app",
			want:       Upstream{Endpoint: "registry-1.docker.io", Repository: "acme/app"},
		},
		{
			name:       "library/ spelled out stays one name",
			host:       "docker.io",
			repository: "library/alpine",
			want:       Upstream{Endpoint: "registry-1.docker.io", Repository: "library/alpine"},
		},
		{
			name:       "every other registry is served by its own host",
			host:       "ghcr.io",
			repository: "acme/app",
			want:       Upstream{Endpoint: "ghcr.io", Repository: "acme/app"},
		},
		{
			// ghcr has no implied namespace, so a single segment stays single.
			name:       "no namespace is implied off Docker Hub",
			host:       "ghcr.io",
			repository: "app",
			want:       Upstream{Endpoint: "ghcr.io", Repository: "app"},
		},
		{
			name:       "ECR is served by its own host",
			host:       "123456789012.dkr.ecr.us-east-1.amazonaws.com",
			repository: "acme/app",
			want:       Upstream{Endpoint: "123456789012.dkr.ecr.us-east-1.amazonaws.com", Repository: "acme/app"},
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got, err := ResolveUpstream(testCase.host, testCase.repository)
			if err != nil {
				t.Fatalf("ResolveUpstream(%q, %q) failed: %v", testCase.host, testCase.repository, err)
			}
			if got != testCase.want {
				t.Errorf("ResolveUpstream(%q, %q) = %+v, want %+v", testCase.host, testCase.repository, got, testCase.want)
			}
		})
	}
}

func TestResolveUpstreamRejectsHostsThatAreNotOne(t *testing.T) {
	cases := []struct {
		name string
		host string
		want error
	}{
		{"empty", "", ErrInvalidHost},
		{"carrying a path", "ghcr.io/acme", ErrInvalidHost},
		{"carrying credentials", "user:pass@ghcr.io", ErrInvalidHost},
		{"carrying a scheme", "https://ghcr.io", ErrInvalidHost},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got, err := ResolveUpstream(testCase.host, "acme/app")
			if err == nil {
				t.Fatalf("ResolveUpstream(%q, …) = %+v, want an error", testCase.host, got)
			}
			if !errors.Is(err, testCase.want) {
				t.Errorf("ResolveUpstream(%q, …) failed with %v, want %v", testCase.host, err, testCase.want)
			}
		})
	}
}

func TestResolveUpstreamRejectsRepositoriesThatBreakTheGrammar(t *testing.T) {
	got, err := ResolveUpstream("ghcr.io", "Acme/App")
	if err == nil {
		t.Fatalf("ResolveUpstream with an uppercase repository = %+v, want an error", got)
	}
	if !errors.Is(err, ErrInvalidName) {
		t.Errorf("failed with %v, want %v", err, ErrInvalidName)
	}
}
