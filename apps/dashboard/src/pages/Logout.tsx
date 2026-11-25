/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */
import { AsciiButton } from '@/components/ascii'
import { AccountEntryLayout } from '@/components/SetupLayout'
import { RoutePath } from '@/enums/RoutePath'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { markJustLoggedOut, prepareSignIn, safeReturnTo } from '@/lib/auth-session'
import { useQueryClient } from '@tanstack/react-query'
import { usePostHog } from 'posthog-js/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link, useLocation } from 'react-router-dom'
import LandingPage from './LandingPage'
import LoadingFallback from '@/components/LoadingFallback'

const Logout = () => {
  const { user, isLoading, removeUser, signoutRedirect, signinRedirect, stopSilentRenew } = useAuth()
  const queryClient = useQueryClient()
  const posthog = usePostHog()
  const location = useLocation()
  const request = useRef({
    switching: new URLSearchParams(location.search).get('switch') === '1',
    returnTo: safeReturnTo(new URLSearchParams(location.search).get('returnTo')),
    idToken: user?.id_token,
  }).current
  const started = useRef(false)
  const [failure, setFailure] = useState(false)
  const [cleared, setCleared] = useState(false)

  const leaveAccount = useCallback(async () => {
    setFailure(false)
    try {
      stopSilentRenew()
      prepareSignIn(request.returnTo)
      await removeUser()
      markJustLoggedOut(request.returnTo)
      posthog?.reset()
      const authenticatedQueries = {
        predicate: (query: { queryKey: readonly unknown[] }) => query.queryKey[0] !== queryKeys.config.all[0],
      }
      await queryClient.cancelQueries(authenticatedQueries)
      queryClient.removeQueries(authenticatedQueries)
      queryClient.getMutationCache().clear()
      setCleared(true)
      // Back and reload must land on a stable page, never replay an account-exit action.
      window.history.replaceState({}, '', RoutePath.LANDING)
      const result: unknown = request.switching
        ? await signinRedirect({ prompt: 'login', state: { returnTo: request.returnTo } })
        : await signoutRedirect({ id_token_hint: request.idToken })
      if (result === null) setFailure(true)
    } catch {
      setFailure(true)
    }
  }, [stopSilentRenew, removeUser, posthog, queryClient, request, signinRedirect, signoutRedirect])

  useEffect(() => {
    if (isLoading || started.current) return
    started.current = true
    request.idToken = user?.id_token
    void leaveAccount()
  }, [isLoading, leaveAccount, request, user])

  if (!failure) return <LoadingFallback />
  if (cleared && request.switching) return <LandingPage />
  return (
    <AccountEntryLayout
      size="compact"
      title={cleared ? 'You’re signed out of BoxLite.' : 'Sign-out couldn’t be completed.'}
      descriptionRole="alert"
      description={
        cleared
          ? 'You’re signed out of BoxLite, but your sign-in provider may still have an active session.'
          : 'We couldn’t clear your local session. Please retry before leaving this browser.'
      }
    >
      <AsciiButton variant="primary" className="h-10 w-full justify-center" onClick={() => void leaveAccount()}>
        Retry sign-out
      </AsciiButton>
      {cleared && (
        <Link to={RoutePath.LANDING} className="mt-4 inline-block text-body underline underline-offset-4">
          Sign in
        </Link>
      )}
    </AccountEntryLayout>
  )
}
export default Logout
