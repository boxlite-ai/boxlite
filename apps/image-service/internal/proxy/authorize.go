// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"errors"
	"fmt"
	"strings"
)

// ErrHostRefused means the registry proxy will not pull from that upstream.
var ErrHostRefused = errors.New("upstream host refused")

// upstreamAllowlist is the set of registries the proxy will pull from.
//
// The upstream host arrives in the request path, so without this the caller
// chooses what the proxy connects to and the proxy is a request relay that
// happens to speak a registry protocol. The address rule in guard.go stops it
// reaching the network it sits on; this stops it reaching the rest of the
// internet on a caller's say-so.
//
// It is a flat set today because there is nothing to key it by: the release
// that introduces this proxy stores no registry credentials, so no organization
// has one and every authenticated caller may reach the same public registries.
// When credentials arrive, an organization's own hosts join what it may reach.
type upstreamAllowlist map[string]struct{}

func newUpstreamAllowlist(hosts []string) upstreamAllowlist {
	allowed := upstreamAllowlist{}
	for _, host := range hosts {
		host = strings.ToLower(strings.TrimSpace(host))
		if host != "" {
			allowed[host] = struct{}{}
		}
	}
	return allowed
}

// permit reports whether a pull may be forwarded to host.
//
// host is the published registry name from the path, not the endpoint it
// resolves to: an operator allows docker.io, which is the name they know, and
// never writes registry-1.docker.io.
func (a upstreamAllowlist) permit(host string) error {
	if _, allowed := a[strings.ToLower(host)]; !allowed {
		return fmt.Errorf("%w: %s is not a registry this proxy pulls from", ErrHostRefused, host)
	}
	return nil
}
