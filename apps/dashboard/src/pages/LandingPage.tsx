/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import LoadingFallback from '@/components/LoadingFallback'
import { RoutePath } from '@/enums/RoutePath'
import { useEffect, useRef } from 'react'
import { useAuth } from 'react-oidc-context'
import { Navigate, useLocation } from 'react-router-dom'

// No in-app login UI: an unauthenticated visitor is handed straight to the OIDC
// hosted login (Auth0 in dev/prod, Dex locally). Branding the login page belongs
// on the IdP side (Universal Login), not here, so the app never collects creds.
const LandingPage: React.FC = () => {
  const { signinRedirect, isAuthenticated, isLoading } = useAuth()
  const location = useLocation()
  const redirecting = useRef(false)

  useEffect(() => {
    if (isLoading || isAuthenticated || redirecting.current) return
    redirecting.current = true
    void signinRedirect({ state: { returnTo: RoutePath.DASHBOARD + location.search } })
  }, [isLoading, isAuthenticated, signinRedirect, location.search])

  if (isAuthenticated) {
    return <Navigate to={`${RoutePath.DASHBOARD}${location.search}`} replace />
  }

  // Brief loading while the redirect to the hosted login is in flight.
  return <LoadingFallback />
}

export default LandingPage
