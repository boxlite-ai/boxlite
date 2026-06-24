/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { LogoText } from '@/assets/Logo'
import LoadingFallback from '@/components/LoadingFallback'
import { RoutePath } from '@/enums/RoutePath'
import { consumeJustLoggedOut } from '@/lib/auth-session'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { Navigate, useLocation } from 'react-router-dom'

// No in-app login UI: an unauthenticated visitor is handed straight to the OIDC
// hosted login (Auth0 in dev/prod, Dex locally). Branding the login page belongs
// on the IdP side (Universal Login), not here, so the app never collects creds.
//
// Exception: a visitor who JUST logged out lands back on '/' (the IdP's
// post_logout_redirect_uri). Auto-redirecting them would defeat the logout and
// loop straight back in when the IdP keeps an SSO cookie, so they get a manual
// sign-in instead.
const LandingPage: React.FC = () => {
  const { signinRedirect, isAuthenticated, isLoading } = useAuth()
  const location = useLocation()
  const redirecting = useRef(false)
  const [loggedOut] = useState(() => consumeJustLoggedOut())

  const signIn = useCallback(() => {
    if (redirecting.current) return
    redirecting.current = true
    void signinRedirect({ state: { returnTo: RoutePath.DASHBOARD + location.search } })
  }, [signinRedirect, location.search])

  useEffect(() => {
    if (isLoading || isAuthenticated || loggedOut) return
    signIn()
  }, [isLoading, isAuthenticated, loggedOut, signIn])

  if (isAuthenticated) {
    return <Navigate to={`${RoutePath.DASHBOARD}${location.search}`} replace />
  }

  if (loggedOut) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-6 px-6 text-center">
        <LogoText className="h-9 w-auto" />
        <p className="font-mono text-[13px] text-muted-foreground">You&apos;ve been signed out.</p>
        <button
          type="button"
          onClick={signIn}
          className="border border-border px-5 py-2.5 text-[13px] font-medium transition-colors hover:bg-card focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
        >
          Sign in
        </button>
      </div>
    )
  }

  // Brief loading while the redirect to the hosted login is in flight.
  return <LoadingFallback />
}

export default LandingPage
