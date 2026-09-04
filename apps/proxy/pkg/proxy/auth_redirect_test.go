// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package proxy

import "testing"

func TestSafeRedirectTarget(t *testing.T) {
	cookieDomain := ".example.com"
	const reqHost = "box.example.com"

	// Untrusted / malicious targets must fall back to "/".
	unsafe := []string{
		"https://evil.com/phish",
		"http://evil.com",
		"//evil.com",
		"/\\evil.com",
		"https://box.example.com.evil.com/x",
		"https://notexample.com",
	}
	for _, rt := range unsafe {
		if got := safeRedirectTarget(rt, reqHost, &cookieDomain); got != "/" {
			t.Errorf("safeRedirectTarget(%q) = %q, want \"/\" (open-redirect must be blocked)", rt, got)
		}
	}

	// Trusted targets pass through unchanged.
	safe := []string{
		"/path/back",
		"https://box.example.com/app",
		"https://app.example.com/dashboard",
	}
	for _, rt := range safe {
		if got := safeRedirectTarget(rt, reqHost, &cookieDomain); got != rt {
			t.Errorf("safeRedirectTarget(%q) = %q, want it unchanged", rt, got)
		}
	}
}
