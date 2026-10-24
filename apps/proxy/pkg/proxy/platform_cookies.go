// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"net/http"
	"strings"
)

const tunnelSessionCookie = "__Host-boxlite-tunnel-session"

func isPlatformCookie(name string) bool {
	return strings.HasPrefix(name, BOX_AUTH_COOKIE_NAME) ||
		strings.HasPrefix(name, "__Host-boxlite-") || name == "pkce_verifier"
}

// Remove credentials for every box, including legacy parent-domain cookies.
// Authentication must run before this boundary; guest application cookies stay.
func stripPlatformCookies(request *http.Request) {
	cookies := request.Cookies()
	request.Header.Del("Cookie")
	for _, cookie := range cookies {
		if !isPlatformCookie(cookie.Name) {
			request.AddCookie(cookie)
		}
	}
}

type guestCookieTransport struct {
	next http.RoundTripper
}

func (transport guestCookieTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	response, err := transport.next.RoundTrip(request)
	if err != nil {
		return nil, err
	}
	values := response.Header.Values("Set-Cookie")
	response.Header.Del("Set-Cookie")
	for _, value := range values {
		name, _, _ := strings.Cut(value, "=")
		if !isPlatformCookie(strings.TrimSpace(name)) {
			response.Header.Add("Set-Cookie", value)
		}
	}
	if private, _ := request.Context().Value(privateTunnelKey{}).(bool); private {
		response.Header.Set("Referrer-Policy", "no-referrer")
		response.Header.Set("Cache-Control", "private, no-store")
	}
	return response, nil
}
