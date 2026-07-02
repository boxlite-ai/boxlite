/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

// Bridges the logout flow to the landing page. `signoutRedirect` ends the IdP
// session and returns the browser to '/', where LandingPage would otherwise
// immediately re-initiate login — defeating the logout, and looping straight
// back into the dashboard when the IdP still holds an SSO cookie. We mark the
// logout here so the landing page shows a manual sign-in instead of auto-
// redirecting. sessionStorage survives the cross-origin round-trip to the IdP
// and back within the same tab, and clears on tab close.
const JUST_LOGGED_OUT_KEY = 'boxlite-just-logged-out'

export function markJustLoggedOut() {
  try {
    sessionStorage.setItem(JUST_LOGGED_OUT_KEY, '1')
  } catch {
    /* sessionStorage may be unavailable (private mode, etc.) */
  }
}

// Reads and clears the flag — a logout is consumed exactly once, so a later
// plain visit to '/' auto-redirects as usual.
export function consumeJustLoggedOut(): boolean {
  try {
    const flagged = sessionStorage.getItem(JUST_LOGGED_OUT_KEY) === '1'
    if (flagged) sessionStorage.removeItem(JUST_LOGGED_OUT_KEY)
    return flagged
  } catch {
    return false
  }
}
