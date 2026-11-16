/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */
import { AccountEntryLayout } from '@/components/SetupLayout'
import { AsciiButton } from '@/components/ascii'
import { getSignInIntent, prepareSignIn, safeReturnTo } from '@/lib/auth-session'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { Navigate, useLocation } from 'react-router-dom'

const LandingPage: React.FC = () => {
  const { signinRedirect, removeUser, user, isAuthenticated, isLoading, error, activeNavigator } = useAuth()
  const location = useLocation()
  const redirecting = useRef(false)
  const [intent] = useState(getSignInIntent)
  const [opening, setOpening] = useState(false)
  const [failure, setFailure] = useState(false)
  const errorCode = (error?.innerError as { error?: string } | undefined)?.error
  const cancelled = errorCode === 'access_denied'
  const returnTo = safeReturnTo(location.state?.returnTo ?? intent?.returnTo ?? location.pathname)

  const signIn = useCallback(
    async (chooseAccount = true) => {
      if (redirecting.current) return
      redirecting.current = true
      setOpening(true)
      setFailure(false)
      try {
        prepareSignIn(returnTo)
        if (user) await removeUser()
        // The context wrapper returns null on failure rather than rejecting.
        const result: unknown = await signinRedirect({
          ...(chooseAccount ? { prompt: 'login' } : {}),
          state: { returnTo },
        })
        if (result === null) setFailure(true)
      } catch {
        setFailure(true)
      } finally {
        redirecting.current = false
        setOpening(false)
      }
    },
    [signinRedirect, removeUser, user, returnTo],
  )

  useEffect(() => {
    if (isLoading || isAuthenticated || error || activeNavigator || getSignInIntent() || failure) return
    void signIn(false)
  }, [isLoading, isAuthenticated, error, activeNavigator, failure, signIn])

  if (isAuthenticated && !error && !intent) return <Navigate to={returnTo} replace />
  const busy = Boolean(opening) || isLoading

  return (
    <AccountEntryLayout
      size="compact"
      centered
      title="Sign in to BoxLite"
      description={intent?.signedOut ? 'You’re signed out.' : 'Sign in to manage your Boxes and organizations.'}
    >
      <AsciiButton
        variant="primary"
        onClick={() => void signIn(false)}
        disabled={busy}
        aria-busy={busy}
        className="h-10 w-full justify-center px-4"
      >
        {opening ? 'Opening sign-in…' : isLoading ? 'Checking session…' : 'Sign in'}
      </AsciiButton>
      <AsciiButton
        variant="quiet"
        disabled={busy}
        onClick={() => void signIn(true)}
        className="mt-2 h-10 w-full justify-center px-4"
      >
        Use another account
      </AsciiButton>
      {!busy && (failure || (error && !cancelled)) && (
        <p role="alert" className="mt-4 text-body text-destructive">
          {errorCode === 'mock_auth_unavailable'
            ? 'Account switching requires the real sign-in service. This preview uses a test identity.'
            : 'We couldn’t sign you in. Please try again.'}
        </p>
      )}
    </AccountEntryLayout>
  )
}
export default LandingPage
