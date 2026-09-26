// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package oci

import (
	"fmt"
	"regexp"
	"strings"
)

// Kind names the distribution endpoint a pull path addresses.
type Kind string

const (
	KindManifest Kind = "manifests"
	KindBlob     Kind = "blobs"
)

// Request is one pull, exactly as its URL path spells it.
type Request struct {
	// Name is the repository name the path carries, unnormalized: the bytes
	// that arrive are the bytes that get forwarded.
	Name string
	Kind Kind
	// Reference is a tag or a digest for a manifest, and always a digest for a
	// blob.
	Reference string
}

// PathPrefix is the root every distribution endpoint hangs off.
const PathPrefix = "/v2/"

// Grammar from the OCI distribution specification, §"Pulling manifests" and
// §"Pulling blobs". Anchored, because a partial match would let a crafted path
// smuggle segments past the checks that follow.
var (
	namePattern   = regexp.MustCompile(`^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*)*$`)
	tagPattern    = regexp.MustCompile(`^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$`)
	digestPattern = regexp.MustCompile(`^[a-z0-9]+(?:[.+_-][a-z0-9]+)*:[a-zA-Z0-9=_-]+$`)
)

const (
	// nameMaxLength is the specification's own cap on the whole repository name.
	nameMaxLength    = 255
	pullPathSegments = 3 // <name…>/<kind>/<reference>, name folded to one
)

// ParseRequest reads a pull off a distribution URL path.
//
// The repository name may itself hold slashes, so the tail is read first and
// whatever precedes it is the name — the same way a registry reads its own
// routes (go-containerregistry pkg/registry/manifest.go:95-98).
//
// urlPath is the decoded path. Percent-encoding can only split a segment, never
// join two, so a name written with %2F reads as the same name written plainly —
// and the grammar rejects anything left encoded.
func ParseRequest(urlPath string) (Request, error) {
	rest, addressed := strings.CutPrefix(urlPath, PathPrefix)
	if !addressed {
		return Request{}, fmt.Errorf("%w: %q does not start with %q", ErrNotPullPath, urlPath, PathPrefix)
	}

	segments := strings.Split(rest, "/")
	if len(segments) < pullPathSegments {
		return Request{}, fmt.Errorf("%w: %q is not <name>/<kind>/<reference>", ErrNotPullPath, urlPath)
	}

	kind := Kind(segments[len(segments)-2])
	if kind != KindManifest && kind != KindBlob {
		return Request{}, fmt.Errorf("%w: %q addresses neither %q nor %q", ErrNotPullPath, urlPath, KindManifest, KindBlob)
	}

	request := Request{
		Name:      strings.Join(segments[:len(segments)-2], "/"),
		Kind:      kind,
		Reference: segments[len(segments)-1],
	}
	if err := checkName(request.Name); err != nil {
		return Request{}, err
	}
	if err := checkReference(request.Kind, request.Reference); err != nil {
		return Request{}, err
	}
	return request, nil
}

// PullPath spells a pull as a distribution URL path. A forwarded pull keeps its
// kind and reference and changes only the repository, so the same grammar
// serves both the request that arrives and the one that leaves.
func PullPath(repository string, kind Kind, reference string) string {
	return PathPrefix + repository + "/" + string(kind) + "/" + reference
}

func checkName(name string) error {
	if len(name) > nameMaxLength {
		return fmt.Errorf("%w: %d characters exceeds the %d-character limit", ErrInvalidName, len(name), nameMaxLength)
	}
	if !namePattern.MatchString(name) {
		return fmt.Errorf("%w: %q", ErrInvalidName, name)
	}
	return nil
}

// A blob is only ever addressed by digest; a manifest may use either form.
func checkReference(kind Kind, reference string) error {
	if digestPattern.MatchString(reference) {
		return nil
	}
	if kind == KindManifest && tagPattern.MatchString(reference) {
		return nil
	}
	return fmt.Errorf("%w: %q is not a valid %s reference", ErrInvalidReference, reference, kind)
}
