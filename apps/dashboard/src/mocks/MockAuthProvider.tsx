/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */
import { AsciiButton } from '@/components/ascii'
import { RoutePath } from '@/enums/RoutePath'
import { completeSignIn, safeReturnTo } from '@/lib/auth-session'
import { useState, type ReactNode } from 'react'
import { AuthContext, type AuthContextProps } from 'react-oidc-context'
import type { SigninRedirectArgs, User } from 'oidc-client-ts'
import { MOCK_ACCOUNTS, MOCK_USER } from './fixtures'

const SIGNED_OUT_KEY = 'mock-signed-out'
const noop = async () => undefined

function finishSignIn(index: number, returnTo: string) {
  sessionStorage.setItem('mock-account', String(index))
  localStorage.removeItem(SIGNED_OUT_KEY)
  completeSignIn()
  window.location.replace(returnTo)
}

// Development only: fixture identity selection is a debug tool, not a hosted login UI.
export function MockAuthProvider({ children }: { children: ReactNode }) {
  const [signedOut, setSignedOut] = useState(() => localStorage.getItem(SIGNED_OUT_KEY) === '1')
  const [debugEnabled] = useState(() => new URLSearchParams(window.location.search).get('authDebug') === '1')
  const [debugOpen, setDebugOpen] = useState(false)
  const [error, setError] = useState<Error>()
  const removeUser = async () => {
    localStorage.setItem(SIGNED_OUT_KEY, '1')
    setSignedOut(true)
  }
  const signinRedirect = async (args?: SigninRedirectArgs) => {
    const returnTo = safeReturnTo((args?.state as { returnTo?: string })?.returnTo)
    if (args?.prompt) {
      setError(
        Object.assign(new Error('Real authentication required'), { innerError: { error: 'mock_auth_unavailable' } }),
      )
      return null
    }
    // No provider UI is simulated. The debug panel can explicitly select a fixture.
    finishSignIn(debugEnabled ? MOCK_ACCOUNTS.indexOf(MOCK_USER) : 0, returnTo)
  }
  const signoutRedirect = async () => {
    await removeUser()
    window.location.replace(RoutePath.LANDING)
  }
  const mockAuth = {
    isAuthenticated: !signedOut,
    isLoading: false,
    activeNavigator: undefined,
    error,
    user: signedOut
      ? undefined
      : ({
          access_token: 'mock-access-token',
          token_type: 'Bearer',
          profile: { ...MOCK_USER, email_verified: true },
          expired: false,
          scopes: ['openid', 'profile', 'email'],
        } as unknown as User),
    settings: {},
    events: {},
    signinRedirect,
    signinSilent: signinRedirect,
    signinPopup: signinRedirect,
    signinResourceOwnerCredentials: signinRedirect,
    signoutRedirect,
    signoutPopup: signoutRedirect,
    signoutSilent: signoutRedirect,
    removeUser,
    revokeTokens: noop,
    startSilentRenew: () => undefined,
    stopSilentRenew: () => undefined,
    clearStaleState: noop,
    querySessionStatus: noop,
  } as unknown as AuthContextProps

  return (
    <AuthContext.Provider value={mockAuth}>
      {children}
      <aside aria-label="Preview environment" className="fixed bottom-4 left-4 z-50 text-meta text-muted-foreground">
        {debugEnabled ? (
          <div className="border border-border bg-background p-3">
            <AsciiButton variant="quiet" size="sm" aria-expanded={debugOpen} onClick={() => setDebugOpen(!debugOpen)}>
              Developer fixtures
            </AsciiButton>
            {debugOpen && (
              <div className="mt-2 space-y-2">
                <p>Mock identity — not saved login accounts</p>
                {MOCK_ACCOUNTS.map((account, index) => (
                  <AsciiButton
                    key={account.sub}
                    size="sm"
                    className="block w-full"
                    onClick={() => finishSignIn(index, RoutePath.DASHBOARD)}
                  >
                    Load fixture: {account.email}
                  </AsciiButton>
                ))}
              </div>
            )}
          </div>
        ) : (
          <span>Preview</span>
        )}
      </aside>
    </AuthContext.Provider>
  )
}
