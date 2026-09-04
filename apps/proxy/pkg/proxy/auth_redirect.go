// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"net"
	"net/url"
	"strings"
)

// safeRedirectTarget validates the post-login `returnTo` taken from the OAuth
// `state` parameter before it is used in an HTTP redirect. The legitimate value
// is always an absolute URL on the proxy's own host (see getAuthUrl), but state
// is only base64-encoded and is attacker-controllable, so an unvalidated value
// is an open redirect. Returns the target unchanged when it is safe, otherwise
// falls back to "/" on the current origin.
//
// Safe means: a host-relative path, or an absolute URL whose host is the request
// host or shares the box-serving (cookie) domain. Protocol-relative ("//host")
// and backslash-obfuscated targets are rejected outright.
func safeRedirectTarget(returnTo, requestHost string, cookieDomain *string) string {
	const fallback = "/"

	if returnTo == "" {
		return fallback
	}
	// "//evil.com" is protocol-relative; "/\evil.com" and "\\evil.com" are
	// browser-normalized to a host. Reject before parsing.
	if strings.HasPrefix(returnTo, "//") || strings.Contains(returnTo, "\\") {
		return fallback
	}

	parsed, err := url.Parse(returnTo)
	if err != nil {
		return fallback
	}

	// Host-relative path on the current origin.
	if parsed.Host == "" {
		if strings.HasPrefix(returnTo, "/") {
			return returnTo
		}
		return fallback
	}

	host := strings.ToLower(redirectHostWithoutPort(parsed.Host))
	reqHost := strings.ToLower(redirectHostWithoutPort(requestHost))
	if host == reqHost {
		return returnTo
	}

	base := ""
	if cookieDomain != nil && *cookieDomain != "" {
		base = strings.ToLower(strings.TrimPrefix(redirectHostWithoutPort(*cookieDomain), "."))
	}
	if base != "" && (host == base || strings.HasSuffix(host, "."+base)) {
		return returnTo
	}

	return fallback
}

func redirectHostWithoutPort(host string) string {
	if h, _, err := net.SplitHostPort(host); err == nil {
		return h
	}
	return host
}
