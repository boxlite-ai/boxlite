// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"maps"
	"net"
	"net/url"
	"slices"
	"strings"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

// corsMiddleware reflects the request Origin with credentials only for trusted
// origins. The previous implementation reflected ANY origin while also setting
// Access-Control-Allow-Credentials: true, which let any website read a victim's
// authenticated box preview / toolbox responses cross-origin. CORS credentialed
// access is now scoped to origins that share the box-serving (cookie) domain —
// the same scope the auth cookie is set on — plus an explicit operator allowlist
// (e.g. a dashboard hosted on a different domain).
func corsMiddleware(allowedOrigins []string, cookieDomain *string) gin.HandlerFunc {
	return func(ctx *gin.Context) {
		if ctx.Request.Header.Get("X-BoxLite-Disable-CORS") == "true" {
			ctx.Request.Header.Del("X-BoxLite-Disable-CORS")
			return
		}

		requestHost := ctx.Request.Host
		corsConfig := cors.DefaultConfig()
		corsConfig.AllowOriginFunc = func(origin string) bool {
			return corsOriginAllowed(origin, requestHost, cookieDomain, allowedOrigins)
		}
		corsConfig.AllowCredentials = true
		corsConfig.AllowHeaders = slices.Collect(maps.Keys(ctx.Request.Header))
		corsConfig.AllowHeaders = append(corsConfig.AllowHeaders, ctx.Request.Header.Values("Access-Control-Request-Headers")...)

		cors.New(corsConfig)(ctx)
	}
}

// corsOriginAllowed reports whether origin may receive a credentialed CORS
// response for a request served on requestHost. An origin is trusted when it is
// the same host as the request, shares the configured cookie/serving domain, or
// is listed verbatim in the operator allowlist. Everything else (e.g. evil.com)
// is rejected, so the browser blocks cross-origin reads of authenticated content.
func corsOriginAllowed(origin, requestHost string, cookieDomain *string, allowlist []string) bool {
	if origin == "" {
		return false
	}

	for _, allowed := range allowlist {
		if strings.EqualFold(strings.TrimSpace(allowed), origin) {
			return true
		}
	}

	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}
	originHost := strings.ToLower(parsed.Hostname())
	if originHost == "" {
		return false
	}

	reqHost := strings.ToLower(hostWithoutPort(requestHost))
	if originHost == reqHost {
		return true
	}

	base := corsBaseDomain(cookieDomain, reqHost)
	if base == "" {
		return false
	}
	return originHost == base || strings.HasSuffix(originHost, "."+base)
}

// corsBaseDomain returns the registrable serving domain (no leading dot, lower
// case) that box subdomains live under. It prefers the configured cookie domain
// (which is exactly the scope the auth cookie is shared on) and falls back to the
// request host so that, absent configuration, only the exact host is trusted.
func corsBaseDomain(cookieDomain *string, reqHost string) string {
	if cookieDomain != nil && *cookieDomain != "" {
		return strings.ToLower(strings.TrimPrefix(hostWithoutPort(*cookieDomain), "."))
	}
	return reqHost
}

func hostWithoutPort(host string) string {
	if h, _, err := net.SplitHostPort(host); err == nil {
		return h
	}
	return host
}
