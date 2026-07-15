/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

// Drop-in replacement for react-oidc-context's <AuthProvider> used only by the
// MSW mock target. It reports an authenticated session so the dashboard renders
// without a real OIDC server. Sign-out/sign-in are simulated via a localStorage
// flag + reload so the login screen is reachable in the mock target for review;
// tokens are never sent anywhere (MSW intercepts requests).

import { RoutePath } from '@/enums/RoutePath'
import type { ReactNode } from 'react'
import { AuthContext, type AuthContextProps } from 'react-oidc-context'
import type { User } from 'oidc-client-ts'
import { MOCK_USER } from './fixtures'

const SIGNED_OUT_KEY = 'mock-signed-out'

function isSignedOut(): boolean {
  try {
    return localStorage.getItem(SIGNED_OUT_KEY) === '1'
  } catch {
    return false
  }
}

const mockUser = {
  access_token: 'mock-access-token',
  token_type: 'Bearer',
  profile: {
    sub: MOCK_USER.sub,
    name: MOCK_USER.name,
    email: MOCK_USER.email,
    email_verified: true,
    picture: MOCK_USER.picture,
  },
  expired: false,
  scopes: ['openid', 'profile', 'email'],
} as unknown as User

const noop = async () => undefined

// Simulated login: clear the signed-out flag and return to the dashboard.
const mockSignIn = async () => {
  try {
    localStorage.removeItem(SIGNED_OUT_KEY)
  } catch {
    /* localStorage may be unavailable */
  }
  window.location.assign(RoutePath.DASHBOARD)
}

// Simulated logout: set the flag and return to the landing/login screen.
const mockSignOut = async () => {
  try {
    localStorage.setItem(SIGNED_OUT_KEY, '1')
  } catch {
    /* localStorage may be unavailable */
  }
  window.location.assign(RoutePath.LANDING)
}

export function MockAuthProvider({ children }: { children: ReactNode }) {
  const signedOut = isSignedOut()

  const mockAuth = {
    isAuthenticated: !signedOut,
    isLoading: false,
    activeNavigator: undefined,
    error: undefined,
    user: signedOut ? undefined : mockUser,
    settings: {},
    events: {},
    signinRedirect: mockSignIn,
    signinSilent: mockSignIn,
    signinPopup: mockSignIn,
    signinResourceOwnerCredentials: mockSignIn,
    signoutRedirect: mockSignOut,
    signoutPopup: mockSignOut,
    signoutSilent: mockSignOut,
    removeUser: mockSignOut,
    revokeTokens: noop,
    startSilentRenew: () => undefined,
    stopSilentRenew: () => undefined,
    clearStaleState: noop,
    querySessionStatus: noop,
  } as unknown as AuthContextProps

  return <AuthContext.Provider value={mockAuth}>{children}</AuthContext.Provider>
}
