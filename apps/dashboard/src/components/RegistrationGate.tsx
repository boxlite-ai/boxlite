/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from 'react-oidc-context'
import { Link } from 'react-router-dom'
import { RegistrationEmailError, RegistrationError } from '@/api/errors'
import { LogoText } from '@/assets/Logo'
import { useApi } from '@/hooks/useApi'
import { useConfig } from '@/hooks/useConfig'
import { RoutePath } from '@/enums/RoutePath'
import LoadingFallback from './LoadingFallback'
import { Turnstile } from './Turnstile'
import { Button } from './ui/button'

export function RegistrationGate({ children }: { children: ReactNode }) {
  const api = useApi()
  const { turnstile } = useConfig()
  const { user } = useAuth()
  const [token, setToken] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [emailError, setEmailError] = useState<RegistrationEmailError | null>(null)
  const [challenge, setChallenge] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [admitted, setAdmitted] = useState(false)
  const pending = useRef(false)
  const account = useQuery({
    queryKey: ['users', 'registration', user?.profile.sub],
    enabled: Boolean(turnstile?.sitekey),
    queryFn: ({ signal }) =>
      api.userApi.getAuthenticatedUser({ signal, timeout: 10_000 }).then((response) => response.data),
    retry: false,
    placeholderData: undefined,
    refetchOnWindowFocus: false,
    staleTime: 0,
  })
  const needsRegistration = account.error instanceof RegistrationError && account.error.code === 'registration_required'

  useEffect(() => {
    if (needsRegistration) setAdmitted(false)
    else if (account.isSuccess && account.isFetchedAfterMount) setAdmitted(true)
  }, [needsRegistration, account.isSuccess, account.isFetchedAfterMount])

  async function register() {
    if (!token || pending.current) return
    pending.current = true
    setSubmitting(true)
    setMessage('')
    try {
      await api.register(token)
      await account.refetch()
    } catch (error) {
      if (error instanceof RegistrationEmailError) {
        setEmailError(error)
      } else if (error instanceof RegistrationError) {
        setMessage(error.message)
      } else {
        // A lost response can follow a committed registration. Read before asking for another challenge.
        const result = await account.refetch()
        if (!result.isSuccess) setMessage('Registration could not be confirmed. Please try again.')
      }
    } finally {
      setToken(null)
      setChallenge((value) => value + 1)
      pending.current = false
      setSubmitting(false)
    }
  }

  if (!turnstile?.sitekey) return children
  if (emailError) throw emailError
  if (account.error instanceof RegistrationEmailError) throw account.error
  // Background revalidation must not tear down live terminals for an admitted identity.
  if (admitted && !needsRegistration) return children
  if (!account.isFetchedAfterMount || account.isPending || account.isFetching) return <LoadingFallback />
  if (account.isSuccess) return children

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 px-6 text-center">
      <LogoText className="h-9 w-auto" />
      <h1 className="text-section font-semibold">Complete your account</h1>
      <p className="max-w-md text-body text-muted-foreground">
        {needsRegistration
          ? 'Verify you are human to start using BoxLite.'
          : 'Registration is temporarily unavailable. Please try again.'}
      </p>
      {message && (
        <p role="alert" className="max-w-md text-body text-destructive">
          {message}
        </p>
      )}
      {needsRegistration ? (
        <>
          <Turnstile key={challenge} {...turnstile} onToken={setToken} />
          <Button onClick={() => void register()} disabled={!token || submitting}>
            {submitting ? 'Creating account…' : 'Continue'}
          </Button>
        </>
      ) : (
        <Button onClick={() => void account.refetch()} disabled={account.isFetching}>
          Try again
        </Button>
      )}
      <Link to={RoutePath.LOGOUT} className="text-body underline underline-offset-4">
        Sign out
      </Link>
    </main>
  )
}
