/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { LogoText } from '@/assets/Logo'
import LoadingFallback from '@/components/LoadingFallback'
import { AsciiButton } from '@/components/ascii'
import { ArrowRightIcon } from '@/components/ui/icon'
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
      <main className="flex min-h-svh items-center justify-center bg-background px-6 py-12">
        <section aria-labelledby="signed-out-title" className="w-full max-w-[360px] text-center">
          <div className="mb-10 flex items-center justify-center">
            <LogoText className="h-11 w-auto" />
          </div>
          <div className="text-center">
            <h1
              id="signed-out-title"
              className="font-display text-[30px] font-semibold leading-tight tracking-tight text-foreground"
            >
              You’re signed out.
            </h1>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">Sign in to continue.</p>
            <AsciiButton variant="primary" onClick={signIn} className="mt-8 h-11 w-full justify-center gap-2 px-4">
              Sign in
              <ArrowRightIcon className="size-4" aria-hidden="true" />
            </AsciiButton>
          </div>
        </section>
      </main>
    )
  }

  // Brief loading while the redirect to the hosted login is in flight.
  return <LoadingFallback />
}

export default LandingPage
