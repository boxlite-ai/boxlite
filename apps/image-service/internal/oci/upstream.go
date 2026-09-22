// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package oci

import (
	"fmt"
	"net/url"
	"strings"
)

// Upstream is where a pull goes: the registry endpoint that serves it, and the
// repository path that endpoint spells it with.
type Upstream struct {
	Endpoint   string
	Repository string
}

// Docker Hub is the one registry whose published host is not its distribution
// endpoint. Writing docker.io on the wire reaches the website, not the
// registry, so a pull that keeps the published host fails for every Docker Hub
// image while every other registry keeps working — which is why this mapping is
// explicit rather than a redirect we hope upstream serves.
//
// go-containerregistry makes the same substitution at the same point
// (pkg/name/registry.go:134-137) but lands on index.docker.io; both answer, and
// registry-1.docker.io is the endpoint the token service scopes itself to.
const (
	dockerHubHost      = "docker.io"
	dockerHubEndpoint  = "registry-1.docker.io"
	dockerHubNamespace = "library"
)

// ResolveUpstream maps a registry host and repository onto the endpoint that
// serves them.
//
// Docker Hub also implies a library/ namespace for a single-segment repository,
// so alpine and library/alpine name one image. Folding them here keeps a
// catalog from carrying the same image under two names
// (go-containerregistry pkg/name/repository.go:42-45).
func ResolveUpstream(host, repository string) (Upstream, error) {
	if err := checkHost(host); err != nil {
		return Upstream{}, err
	}
	if err := checkName(repository); err != nil {
		return Upstream{}, err
	}

	if host != dockerHubHost {
		return Upstream{Endpoint: host, Repository: repository}, nil
	}
	if !strings.Contains(repository, "/") {
		repository = dockerHubNamespace + "/" + repository
	}
	return Upstream{Endpoint: dockerHubEndpoint, Repository: repository}, nil
}

// checkHost holds the host to what a URL can carry as its authority, so a
// resolved endpoint cannot smuggle a path, a port that is not one, or
// credentials into the URL the client builds from it.
func checkHost(host string) error {
	if host == "" {
		return fmt.Errorf("%w: empty", ErrInvalidHost)
	}
	// Per RFC 3986 an authority is what follows "//", so that is what it has to
	// parse as, and to parse as nothing else.
	parsed, err := url.Parse("//" + host)
	if err != nil || parsed.Host != host {
		return fmt.Errorf("%w: %q is not a URI authority", ErrInvalidHost, host)
	}
	return nil
}
