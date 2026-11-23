/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */
import { RoutePath } from '@/enums/RoutePath'
import { CI_CALLBACK_PATH, clearCiConnectSession } from './ci-connect'
import { ORGANIZATION_SESSION_KEY } from './organization-session'
import { clearPendingPlanUpgrade } from './pending-plan-upgrade'

const SIGN_IN_INTENT_KEY = 'boxlite-just-logged-out'
type SignInIntent = { signedOut: boolean; returnTo: string }

export function safeReturnTo(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.includes('\\') ||
    [...value].some((character) => character.charCodeAt(0) <= 32) ||
    value.startsWith('//')
  )
    return RoutePath.DASHBOARD
  try {
    const url = new URL(value, window.location.origin)
    if (url.origin === window.location.origin && url.pathname === CI_CALLBACK_PATH) return CI_CALLBACK_PATH
    if (
      url.origin === window.location.origin &&
      (url.pathname === RoutePath.DASHBOARD || url.pathname.startsWith(`${RoutePath.DASHBOARD}/`))
    ) {
      return url.pathname + url.search + url.hash
    }
  } catch {
    /* An invalid destination returns to the Console home. */
  }
  return RoutePath.DASHBOARD
}

// Reading never consumes intent: refresh, Back and StrictMode must remain manual.
export function getSignInIntent(): SignInIntent | null {
  try {
    const raw = sessionStorage.getItem(SIGN_IN_INTENT_KEY)
    if (!raw) return null
    if (raw === '1') return { signedOut: true, returnTo: RoutePath.DASHBOARD }
    const intent = JSON.parse(raw)
    return { signedOut: intent.signedOut === true, returnTo: safeReturnTo(intent.returnTo) }
  } catch {
    // A failed read must not authorize an automatic SSO redirect.
    return { signedOut: false, returnTo: RoutePath.DASHBOARD }
  }
}

export function markJustLoggedOut(returnTo?: unknown) {
  clearPendingPlanUpgrade()
  sessionStorage.setItem(SIGN_IN_INTENT_KEY, JSON.stringify({ signedOut: true, returnTo: safeReturnTo(returnTo) }))
  sessionStorage.removeItem(ORGANIZATION_SESSION_KEY)
  clearCiConnectSession()
}

export function prepareSignIn(returnTo: unknown) {
  sessionStorage.setItem(
    SIGN_IN_INTENT_KEY,
    JSON.stringify({
      signedOut: getSignInIntent()?.signedOut ?? false,
      returnTo: safeReturnTo(returnTo),
    }),
  )
}

export function completeSignIn() {
  // Silent renewal has no interactive intent and keeps its organization selection.
  if (getSignInIntent()) sessionStorage.removeItem(ORGANIZATION_SESSION_KEY)
  sessionStorage.removeItem(SIGN_IN_INTENT_KEY)
}

export function accountSwitchPath(returnTo?: string): string {
  return `${RoutePath.LOGOUT}?switch=1&returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`
}
