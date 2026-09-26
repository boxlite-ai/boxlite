// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"errors"
	"testing"
)

// The upstream host arrives in the request path, so an allowlist is the only
// thing between an authenticated caller and any host they care to name.
func TestUpstreamAllowlistPermitsOnlyWhatItWasGiven(t *testing.T) {
	allowed := newUpstreamAllowlist([]string{"ghcr.io", " docker.io ", ""})

	for _, host := range []string{"ghcr.io", "docker.io", "GHCR.IO"} {
		if err := allowed.permit(host); err != nil {
			t.Errorf("permit(%q) = %v, want the host allowed", host, err)
		}
	}
	for _, host := range []string{"evil.example.com", "", "ghcr.io.evil.example.com", "registry-1.docker.io"} {
		if err := allowed.permit(host); !errors.Is(err, ErrHostRefused) {
			t.Errorf("permit(%q) = %v, want %v", host, err, ErrHostRefused)
		}
	}
}

// The list is written in the names an operator knows. registry-1.docker.io is
// an endpoint this proxy resolves to on its own, and asking an operator to
// allow it would be asking them to know an implementation detail — which is why
// the check above refuses it.
func TestUpstreamAllowlistIsCheckedAgainstThePublishedName(t *testing.T) {
	route, err := ParseRoute("/v2/acme/docker.io/alpine/manifests/3.20")
	if err != nil {
		t.Fatalf("ParseRoute failed: %v", err)
	}
	if route.Upstream.Endpoint == route.PublishedHost {
		t.Fatal("this test needs a host whose endpoint differs from its published name")
	}

	if err := newUpstreamAllowlist([]string{"docker.io"}).permit(route.PublishedHost); err != nil {
		t.Errorf("permit(%q) = %v, want the published name allowed", route.PublishedHost, err)
	}
}

func TestEmptyUpstreamAllowlistPermitsNothing(t *testing.T) {
	if err := newUpstreamAllowlist(nil).permit("ghcr.io"); !errors.Is(err, ErrHostRefused) {
		t.Errorf("permit on an empty list = %v, want %v", err, ErrHostRefused)
	}
}
