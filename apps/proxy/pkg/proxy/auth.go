// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	common_errors "github.com/boxlite-ai/common-go/pkg/errors"
	"github.com/gin-gonic/gin"
)

func (p *Proxy) Authenticate(ctx *gin.Context, boxId string) (string, bool, error) {
	var authErrors []string

	// Try Authorization header with Bearer token
	bearerToken := p.getBearerToken(ctx)
	if bearerToken != "" {
		isValid, err := p.getBoxBearerTokenValid(ctx, boxId, bearerToken)
		if err != nil {
			authErrors = append(authErrors, fmt.Sprintf("Bearer token validation error: %v", err))
		} else if isValid != nil && *isValid {
			return boxId, false, nil
		} else {
			authErrors = append(authErrors, "Bearer token is invalid")
		}
	}

	// Try cookie authentication
	cookieBoxId, err := ctx.Cookie(BOX_AUTH_COOKIE_NAME + boxId)
	if err == nil && cookieBoxId != "" {
		decodedValue := ""
		err = p.secureCookie.Decode(BOX_AUTH_COOKIE_NAME+boxId, cookieBoxId, &decodedValue)
		if err != nil {
			authErrors = append(authErrors, fmt.Sprintf("Cookie decoding error: %v", err))
		} else {
			return decodedValue, false, nil
		}
	}

	// All authentication methods failed, redirect to auth URL
	authUrl, err := p.getAuthUrl(ctx, boxId)
	if err != nil {
		return boxId, false, fmt.Errorf("failed to get auth URL: %w", err)
	}

	ctx.Redirect(http.StatusTemporaryRedirect, authUrl)

	// Return error with details about what failed
	var errorMsg string
	if len(authErrors) > 0 {
		errorMsg = fmt.Sprintf("authentication failed: %s", strings.Join(authErrors, ","))
	} else {
		errorMsg = "missing authentication: use an API key or JWT, or sign in"
	}

	return boxId, true, common_errors.NewUnauthorizedError(errors.New(errorMsg))
}

func (p *Proxy) getBearerToken(ctx *gin.Context) string {
	authHeader := ctx.Request.Header.Get("Authorization")
	if authHeader != "" && strings.HasPrefix(authHeader, "Bearer ") {
		return strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer "))
	}
	return ""
}
