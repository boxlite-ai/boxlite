// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package oci

import (
	"errors"
	"strings"
	"testing"
)

func TestParseRequestReadsNamesThatHoldSlashes(t *testing.T) {
	cases := []struct {
		name string
		path string
		want Request
	}{
		{
			name: "manifest by tag",
			path: "/v2/library/alpine/manifests/3.20",
			want: Request{Name: "library/alpine", Kind: KindManifest, Reference: "3.20"},
		},
		{
			name: "manifest by digest",
			path: "/v2/library/alpine/manifests/sha256:ab12cd34",
			want: Request{Name: "library/alpine", Kind: KindManifest, Reference: "sha256:ab12cd34"},
		},
		{
			name: "blob by digest",
			path: "/v2/library/alpine/blobs/sha256:ab12cd34",
			want: Request{Name: "library/alpine", Kind: KindBlob, Reference: "sha256:ab12cd34"},
		},
		{
			// The registry proxy folds an org and an upstream host into the
			// name, so the deepest name this parser sees is four segments and
			// the parse must not stop at the first slash.
			name: "name carrying an org and an upstream host",
			path: "/v2/acme/ghcr.io/acme/app/manifests/1.2",
			want: Request{Name: "acme/ghcr.io/acme/app", Kind: KindManifest, Reference: "1.2"},
		},
		{
			name: "single-segment name",
			path: "/v2/alpine/manifests/latest",
			want: Request{Name: "alpine", Kind: KindManifest, Reference: "latest"},
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got, err := ParseRequest(testCase.path)
			if err != nil {
				t.Fatalf("ParseRequest(%q) failed: %v", testCase.path, err)
			}
			if got != testCase.want {
				t.Errorf("ParseRequest(%q) = %+v, want %+v", testCase.path, got, testCase.want)
			}
		})
	}
}

func TestParseRequestRejectsWhatItCannotForward(t *testing.T) {
	cases := []struct {
		name string
		path string
		want error
	}{
		{"not addressed to /v2/", "/health", ErrNotPullPath},
		{"the version check itself", "/v2/", ErrNotPullPath},
		{"no name before the kind", "/v2/manifests/1.2", ErrNotPullPath},
		{"a kind that is not a pull", "/v2/alpine/tags/list", ErrNotPullPath},
		{"uploads are not pulls", "/v2/alpine/blobs/uploads/abc", ErrNotPullPath},
		{"uppercase in the name", "/v2/Alpine/manifests/1.2", ErrInvalidName},
		{"empty name segment", "/v2/acme//app/manifests/1.2", ErrInvalidName},
		{"name segment opening on a separator", "/v2/acme/-app/manifests/1.2", ErrInvalidName},
		{"name over the length cap", "/v2/" + strings.Repeat("a", 256) + "/manifests/1.2", ErrInvalidName},
		{"a tag that is not one", "/v2/alpine/manifests/.1.2", ErrInvalidReference},
		{"a blob addressed by tag", "/v2/alpine/blobs/1.2", ErrInvalidReference},
		{"a digest without an algorithm", "/v2/alpine/blobs/ab12cd34", ErrInvalidReference},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got, err := ParseRequest(testCase.path)
			if err == nil {
				t.Fatalf("ParseRequest(%q) = %+v, want an error", testCase.path, got)
			}
			if !errors.Is(err, testCase.want) {
				t.Errorf("ParseRequest(%q) failed with %v, want %v", testCase.path, err, testCase.want)
			}
		})
	}
}

// A forwarded pull keeps its kind and reference and changes only the
// repository, so the path that leaves is the path that arrived with one
// substitution — including the colon in a digest, which is a path character
// and must survive as itself.
func TestPullPathSubstitutesOnlyTheRepository(t *testing.T) {
	request, err := ParseRequest("/v2/acme/ghcr.io/acme/app/blobs/sha256:ab12cd34")
	if err != nil {
		t.Fatalf("ParseRequest failed: %v", err)
	}

	got := PullPath("acme/app", request.Kind, request.Reference)
	if want := "/v2/acme/app/blobs/sha256:ab12cd34"; got != want {
		t.Errorf("PullPath = %q, want %q", got, want)
	}
}
