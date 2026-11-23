/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from 'react-oidc-context'
import { RegistrationEmailError, RegistrationError } from '@/api/errors'
import { useApi } from '@/hooks/useApi'
import { useConfig } from '@/hooks/useConfig'
import { SetupLayout } from './SetupLayout'
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
    <SetupLayout
      title={needsRegistration ? 'Verify your account' : 'Let’s try that again'}
      description={
        needsRegistration
          ? 'Complete the security check to create your BoxLite account. Next, we’ll help you set up your organization.'
          : 'We couldn’t confirm your account. Try again to continue.'
      }
    >
      {message && (
        <p role="alert" className="max-w-md text-body text-destructive">
          {message}
        </p>
      )}
      {needsRegistration ? (
        <>
          <Turnstile key={challenge} {...turnstile} onToken={setToken} />
          <Button className="mt-6 h-10 w-full" onClick={() => void register()} disabled={!token || submitting}>
            {submitting ? 'Creating account…' : 'Create account'}
          </Button>
        </>
      ) : (
        <Button onClick={() => void account.refetch()} disabled={account.isFetching}>
          Try again
        </Button>
      )}
    </SetupLayout>
  )
}
