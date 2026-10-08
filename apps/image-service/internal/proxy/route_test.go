// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"errors"
	"testing"

	"github.com/boxlite-ai/image-service/internal/oci"
)

func TestParseRouteSplitsTheOrgAndUpstreamOutOfTheName(t *testing.T) {
	cases := []struct {
		name string
		path string
		want Route
	}{
		{
			name: "ghcr",
			path: "/v2/acme/ghcr.io/acme/app/manifests/1.2",
			want: Route{
				Org:           "acme",
				PublishedHost: "ghcr.io",
				Upstream:      oci.Upstream{Endpoint: "ghcr.io", Repository: "acme/app"},
				Request:       oci.Request{Name: "acme/ghcr.io/acme/app", Kind: oci.KindManifest, Reference: "1.2"},
			},
		},
		{
			// The repository keeps every segment after the host, however deep.
			name: "a repository nested several levels down",
			path: "/v2/acme/ghcr.io/acme/team/app/blobs/sha256:ab12cd34",
			want: Route{
				Org:           "acme",
				PublishedHost: "ghcr.io",
				Upstream:      oci.Upstream{Endpoint: "ghcr.io", Repository: "acme/team/app"},
				Request:       oci.Request{Name: "acme/ghcr.io/acme/team/app", Kind: oci.KindBlob, Reference: "sha256:ab12cd34"},
			},
		},
		{
			// The org is whatever the path says and nothing else supplies it,
			// so an org id with hyphens has to survive the split intact.
			name: "an org id that is a uuid",
			path: "/v2/3f2b7a10-5c9e-4e21-9a44-8b1d6e0f7c35/ghcr.io/acme/app/manifests/1.2",
			want: Route{
				Org:           "3f2b7a10-5c9e-4e21-9a44-8b1d6e0f7c35",
				PublishedHost: "ghcr.io",
				Upstream:      oci.Upstream{Endpoint: "ghcr.io", Repository: "acme/app"},
				Request: oci.Request{
					Name:      "3f2b7a10-5c9e-4e21-9a44-8b1d6e0f7c35/ghcr.io/acme/app",
					Kind:      oci.KindManifest,
					Reference: "1.2",
				},
			},
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got, err := ParseRoute(testCase.path)
			if err != nil {
				t.Fatalf("ParseRoute(%q) failed: %v", testCase.path, err)
			}
			if got != testCase.want {
				t.Errorf("ParseRoute(%q) = %+v, want %+v", testCase.path, got, testCase.want)
			}
		})
	}
}

// A pull whose path says docker.io has to leave for registry-1.docker.io.
// Sending it to docker.io fails for every Docker Hub image while ghcr keeps
// working, which reads as "Docker Hub is broken" rather than as a routing bug —
// so the assertion is on the endpoint the route resolves to.
func TestParseRouteSendsDockerHubToItsRegistryEndpoint(t *testing.T) {
	route, err := ParseRoute("/v2/acme/docker.io/alpine/manifests/3.20")
	if err != nil {
		t.Fatalf("ParseRoute failed: %v", err)
	}

	want := oci.Upstream{Endpoint: "registry-1.docker.io", Repository: "library/alpine"}
	if route.Upstream != want {
		t.Errorf("upstream = %+v, want %+v", route.Upstream, want)
	}
	if route.Org != "acme" {
		t.Errorf("org = %q, want %q", route.Org, "acme")
	}
}

func TestParseRouteRejectsNamesThatCarryNoRoute(t *testing.T) {
	cases := []struct {
		name string
		path string
		want error
	}{
		{"only an org", "/v2/acme/manifests/1.2", ErrNotRoutable},
		{"an org and a host but no repository", "/v2/acme/ghcr.io/manifests/1.2", ErrNotRoutable},
		{"not a pull at all", "/v2/acme/ghcr.io/acme/app/tags/list", oci.ErrNotPullPath},
		{"a name the grammar rejects", "/v2/acme/ghcr.io/Acme/App/manifests/1.2", oci.ErrInvalidName},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got, err := ParseRoute(testCase.path)
			if err == nil {
				t.Fatalf("ParseRoute(%q) = %+v, want an error", testCase.path, got)
			}
			if !errors.Is(err, testCase.want) {
				t.Errorf("ParseRoute(%q) failed with %v, want %v", testCase.path, err, testCase.want)
			}
		})
	}
}
