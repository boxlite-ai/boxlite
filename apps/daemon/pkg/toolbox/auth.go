// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package toolbox

import (
	"crypto/subtle"
	"net/http"
	"os"
	"strings"

	"github.com/gin-gonic/gin"
)

// toolboxAuthExemptPaths are reachable without the box auth token: /init sets the
// token, /version is a harmless liveness probe.
var toolboxAuthExemptPaths = map[string]bool{
	"/init":    true,
	"/version": true,
}

// toolboxAuthMiddleware enforces the box auth token (set via /init, previously
// only used as a telemetry attribute) as a Bearer credential on toolbox requests
// when TOOLBOX_REQUIRE_AUTH=true.
//
// It defaults to OFF so the existing runner→proxy→daemon path keeps working:
// turning it on requires the upstream proxy to forward the token on every
// request, which is a separate, coordinated change (see PR description). When
// enabled, requests to non-exempt paths are rejected unless they carry the exact
// token, and requests that arrive before /init (token unset) are rejected too —
// fail closed.
func (s *server) toolboxAuthMiddleware() gin.HandlerFunc {
	return s.toolboxAuthMiddlewareMode(os.Getenv("TOOLBOX_REQUIRE_AUTH") == "true")
}

func (s *server) toolboxAuthMiddlewareMode(required bool) gin.HandlerFunc {
	return func(ctx *gin.Context) {
		if !required || toolboxAuthExemptPaths[ctx.Request.URL.Path] {
			ctx.Next()
			return
		}
		if s.authToken == "" || !bearerTokenMatches(ctx.GetHeader("Authorization"), s.authToken) {
			ctx.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
		ctx.Next()
	}
}

// bearerTokenMatches reports whether the Authorization header carries exactly the
// expected bearer token, using a constant-time compare to avoid leaking it via
// timing.
func bearerTokenMatches(authHeader, expected string) bool {
	const prefix = "Bearer "
	if !strings.HasPrefix(authHeader, prefix) {
		return false
	}
	got := strings.TrimPrefix(authHeader, prefix)
	return subtle.ConstantTimeCompare([]byte(got), []byte(expected)) == 1
}
