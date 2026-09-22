// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"fmt"
	"strings"

	"github.com/boxlite-ai/image-service/internal/oci"
)

// Route is one inbound pull, split into the org that has to authorize it and
// the upstream pull it forwards to.
type Route struct {
	// Org owns the credential that authorizes this pull.
	//
	// It comes from the path and only from the path. A caller's own credential
	// says which runner is calling, never which org: runners are shared and
	// belong to none, so a runner credential cannot answer "whose image is
	// this?" and must not be read as if it could.
	Org      string
	Upstream oci.Upstream
	Request  oci.Request
}

// The name the registry proxy publishes is <org>/<upstream host>/<repository…>,
// so the two routing segments come off the front and whatever remains is the
// repository the upstream knows.
const routeSegments = 3

// ParseRoute reads the registry proxy's own repository convention off a pull
// path:
//
//	/v2/<org>/<upstream host>/<repository…>/<kind>/<reference>
//
// The upstream host rides in the path rather than in configuration because one
// proxy serves every registry: the path is what says which one, and the org
// beside it is what says who may reach it.
func ParseRoute(urlPath string) (Route, error) {
	request, err := oci.ParseRequest(urlPath)
	if err != nil {
		return Route{}, err
	}

	segments := strings.SplitN(request.Name, "/", routeSegments)
	if len(segments) < routeSegments {
		return Route{}, fmt.Errorf("%w: %q is not <org>/<host>/<repository>", ErrNotRoutable, request.Name)
	}

	upstream, err := oci.ResolveUpstream(segments[1], segments[2])
	if err != nil {
		return Route{}, err
	}
	return Route{Org: segments[0], Upstream: upstream, Request: request}, nil
}
