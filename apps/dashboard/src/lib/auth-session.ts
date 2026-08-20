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
const EMAIL_VERIFICATION_KEY = 'boxlite-email-verification'
const DEFAULT_RETURN_TO = '/dashboard'

interface PendingEmailVerification {
  returnTo: string
  autoResend: boolean
}

interface SigninDestinationOptions {
  emailVerificationRequired: boolean
  emailVerified: boolean | undefined
  returnTo: string | undefined
}

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

export function prepareEmailVerification(returnTo: string | undefined, autoResend: boolean): void {
  const pending: PendingEmailVerification = {
    returnTo: safeDashboardReturnTo(returnTo),
    autoResend,
  }
  try {
    sessionStorage.setItem(EMAIL_VERIFICATION_KEY, JSON.stringify(pending))
  } catch {
    /* best-effort; the page falls back to /dashboard and a manual resend */
  }
}

export function getPendingEmailVerificationReturnTo(): string {
  return readPendingEmailVerification().returnTo
}

export function consumeEmailVerificationAutoResend(): boolean {
  const pending = readPendingEmailVerification()
  if (!pending.autoResend) {
    return false
  }

  try {
    sessionStorage.setItem(EMAIL_VERIFICATION_KEY, JSON.stringify({ ...pending, autoResend: false }))
  } catch {
    return false
  }
  return true
}

export function clearPendingEmailVerification(): void {
  try {
    sessionStorage.removeItem(EMAIL_VERIFICATION_KEY)
  } catch {
    /* best-effort */
  }
}

export function signinDestination(options: SigninDestinationOptions): string {
  const returnTo = safeDashboardReturnTo(options.returnTo)
  if (options.emailVerificationRequired && options.emailVerified !== true) {
    prepareEmailVerification(returnTo, true)
    return '/verify-email'
  }

  clearPendingEmailVerification()
  return returnTo
}

function readPendingEmailVerification(): PendingEmailVerification {
  try {
    const raw = sessionStorage.getItem(EMAIL_VERIFICATION_KEY)
    if (!raw) {
      return { returnTo: DEFAULT_RETURN_TO, autoResend: false }
    }
    const parsed = JSON.parse(raw) as Partial<PendingEmailVerification>
    return {
      returnTo: safeDashboardReturnTo(parsed.returnTo),
      autoResend: parsed.autoResend === true,
    }
  } catch {
    return { returnTo: DEFAULT_RETURN_TO, autoResend: false }
  }
}

function safeDashboardReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) {
    return DEFAULT_RETURN_TO
  }

  try {
    const url = new URL(value, 'https://dashboard.boxlite.invalid')
    if (url.origin !== 'https://dashboard.boxlite.invalid') {
      return DEFAULT_RETURN_TO
    }
    if (url.pathname !== DEFAULT_RETURN_TO && !url.pathname.startsWith(`${DEFAULT_RETURN_TO}/`)) {
      return DEFAULT_RETURN_TO
    }
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return DEFAULT_RETURN_TO
  }
}
