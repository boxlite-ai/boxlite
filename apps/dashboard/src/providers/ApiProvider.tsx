/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiContext } from '@/contexts/ApiContext'
import { useEffect, useRef, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import LoadingFallback from '@/components/LoadingFallback'
import { ApiClient } from '@/api/apiClient'
import { Navigate, useLocation } from 'react-router-dom'
import { getSignInIntent, prepareSignIn } from '@/lib/auth-session'
import { RoutePath } from '@/enums/RoutePath'
import LandingPage from '@/pages/LandingPage'
import { useConfig } from '@/hooks/useConfig'

export const ApiProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, isAuthenticated, isLoading, signinRedirect, removeUser, error, activeNavigator } = useAuth()
  const config = useConfig()
  const location = useLocation()

  const [failed, setFailed] = useState(false)
  const redirecting = useRef(false)
  const requiresManualSignIn = Boolean(getSignInIntent() || config.legal)
  const apiRef = useRef<ApiClient | null>(null)
  const [isApiReady, setIsApiReady] = useState(false)

  // Initialize API client as soon as user is available
  useEffect(() => {
    if (user) {
      if (!apiRef.current) {
        // On a 401 the stored token is invalid (expired, or signed by a rotated
        // Rauthy key). Clearing the user flips isAuthenticated false, which the
        // effect below turns into a redirect to a fresh login (preserving
        // returnTo). Return the removeUser promise (don't void it) so the 401
        // handler can tell a started recovery (suspend) from a failed one
        // (surface an error). The redirect stays owned by the effect below to
        // avoid a double-redirect.
        apiRef.current = new ApiClient(config, user.access_token, () => removeUser())
      } else {
        apiRef.current.setAccessToken(user.access_token)
      }
      setIsApiReady(true)
    } else {
      setIsApiReady(false)
    }
  }, [user, config, removeUser])

  useEffect(() => {
    if (isLoading || isAuthenticated || requiresManualSignIn || error || activeNavigator || redirecting.current) return
    redirecting.current = true
    const returnTo = location.pathname + location.search + location.hash
    try {
      prepareSignIn(returnTo)
      void signinRedirect({ state: { returnTo } })
        .then((result: unknown) => {
          if (result === null) setFailed(true)
        })
        .catch(() => setFailed(true))
    } catch {
      setFailed(true)
    }
  }, [isLoading, isAuthenticated, requiresManualSignIn, error, activeNavigator, signinRedirect, location])

  if (failed || error) return <LandingPage />
  if (!isLoading && !isAuthenticated && requiresManualSignIn && !redirecting.current) {
    return (
      <Navigate
        to={RoutePath.LANDING}
        state={{ returnTo: location.pathname + location.search + location.hash }}
        replace
      />
    )
  }

  if (isLoading || !isApiReady) {
    return <LoadingFallback />
  }

  return <ApiContext.Provider value={apiRef.current}>{children}</ApiContext.Provider>
}
