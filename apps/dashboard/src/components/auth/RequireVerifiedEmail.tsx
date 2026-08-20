/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import LoadingFallback from '@/components/LoadingFallback'
import { RoutePath } from '@/enums/RoutePath'
import { useConfig } from '@/hooks/useConfig'
import { prepareEmailVerification } from '@/lib/auth-session'
import { ReactNode, useEffect } from 'react'
import { useAuth } from 'react-oidc-context'
import { Navigate, useLocation } from 'react-router-dom'

export function RequireVerifiedEmail({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading, user } = useAuth()
  const config = useConfig()
  const location = useLocation()
  const requiresVerification = config.oidc.emailVerificationRequired
  const isBlocked = isAuthenticated && requiresVerification && user?.profile.email_verified !== true
  const returnTo = `${location.pathname}${location.search}`

  useEffect(() => {
    if (isBlocked) {
      prepareEmailVerification(returnTo, false)
    }
  }, [isBlocked, returnTo])

  if (isLoading) {
    return <LoadingFallback />
  }
  if (isBlocked) {
    return <Navigate to={RoutePath.EMAIL_VERIFICATION_PENDING} replace />
  }
  return children
}
