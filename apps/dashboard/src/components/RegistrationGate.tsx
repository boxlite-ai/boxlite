/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from 'react-oidc-context'
import { useNavigate } from 'react-router-dom'
import { RegistrationEmailError, RegistrationError } from '@/api/errors'
import { RoutePath } from '@/enums/RoutePath'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { useApi } from '@/hooks/useApi'
import { useConfig } from '@/hooks/useConfig'
import { LegalDocumentLinks } from './LegalDocumentLinks'
import { SetupLayout } from './SetupLayout'
import LoadingFallback from './LoadingFallback'
import { Turnstile } from './Turnstile'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'

export function RegistrationGate({ children }: { children: ReactNode }) {
  const api = useApi()
  const { turnstile, legal } = useConfig()
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [token, setToken] = useState<string | null>(null)
  const [acceptedLegal, setAcceptedLegal] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [emailError, setEmailError] = useState<RegistrationEmailError | null>(null)
  const [challenge, setChallenge] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [admitted, setAdmitted] = useState(false)
  const pending = useRef(false)
  const consentCheckboxId = useId()
  const identity = user?.profile.sub
  const legalKey = legal
    ? JSON.stringify([legal.tosVersion, legal.privacyVersion, legal.tosUrl, legal.privacyUrl])
    : null
  const accepted = legalKey !== null && acceptedLegal === legalKey
  const account = useQuery({
    queryKey: ['users', 'registration', identity],
    enabled: Boolean(identity),
    queryFn: ({ signal }) =>
      api.userApi.getAuthenticatedUser({ signal, timeout: 10_000 }).then((response) => response.data),
    retry: false,
    placeholderData: undefined,
    refetchOnWindowFocus: false,
    staleTime: 0,
  })
  const needsRegistration = account.error instanceof RegistrationError && account.error.code === 'registration_required'
  // An already-open tab can still hold config from before registration was enabled.
  const registrationConfig = useQuery({
    queryKey: ['users', 'registration', identity, 'config'],
    enabled: needsRegistration,
    queryFn: async () => {
      await queryClient.refetchQueries({ queryKey: queryKeys.config.all, exact: true }, { throwOnError: true })
      return true
    },
    retry: false,
    refetchOnWindowFocus: false,
  })
  const canRegister = needsRegistration && registrationConfig.isSuccess && Boolean(legal || turnstile?.sitekey)
  const canSubmit = canRegister && (!legal || accepted) && (!turnstile?.sitekey || Boolean(token))

  useEffect(() => {
    if (needsRegistration) setAdmitted(false)
    else if (account.isSuccess && account.isFetchedAfterMount) setAdmitted(true)
  }, [needsRegistration, account.isSuccess, account.isFetchedAfterMount])

  async function register() {
    if (!canSubmit || pending.current) return
    pending.current = true
    setSubmitting(true)
    setMessage('')
    try {
      if (legal) {
        await api.register(token ?? undefined, {
          accepted: true,
          tosVersion: legal.tosVersion,
          privacyVersion: legal.privacyVersion,
        })
      } else {
        await api.register(token ?? undefined)
      }
      await account.refetch()
    } catch (error) {
      if (error instanceof RegistrationEmailError) {
        setEmailError(error)
      } else if (error instanceof RegistrationError) {
        setMessage(error.message)
        if (error.code === 'consent_required' || error.code === 'legal_version_mismatch') {
          setAcceptedLegal(null)
          await registrationConfig.refetch()
        }
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

  async function retryAccount() {
    const result = await account.refetch()
    if (
      needsRegistration &&
      result.error instanceof RegistrationError &&
      result.error.code === 'registration_required'
    ) {
      await registrationConfig.refetch()
    }
  }

  if (!identity) return children
  if (emailError) throw emailError
  if (account.error instanceof RegistrationEmailError) throw account.error
  // Background revalidation must not tear down live terminals for an admitted identity.
  if (admitted && !needsRegistration) return children
  if (!account.isFetchedAfterMount || account.isPending || account.isFetching) return <LoadingFallback />
  if (account.isSuccess) return children
  if (needsRegistration && (registrationConfig.isPending || registrationConfig.isFetching)) return <LoadingFallback />

  const title = legal ? 'Complete your account' : 'Verify your account'
  const description = legal
    ? 'Review the terms to create your BoxLite account.'
    : 'Complete the security check to create your BoxLite account. Next, we’ll help you set up your organization.'
  const accountRetryMessage =
    account.error instanceof RegistrationError &&
    (account.error.code === 'account_link_pending' || account.error.code === 'account_link_superseded')
      ? account.error.message
      : 'We couldn’t confirm your account. Try again to continue.'
  const signInAgain = account.error instanceof RegistrationError && account.error.code === 'account_link_superseded'

  return (
    <SetupLayout
      title={canRegister ? title : 'Let’s try that again'}
      description={canRegister ? description : accountRetryMessage}
      compactFooter={canRegister && Boolean(legal)}
    >
      {message && (
        <p role="alert" className="max-w-md text-body text-destructive">
          {message}
        </p>
      )}
      {canRegister ? (
        <div className="grid gap-4">
          {legal && (
            <div className="flex items-start gap-2.5 text-left text-body text-muted-foreground">
              <Checkbox
                id={consentCheckboxId}
                checked={accepted}
                onCheckedChange={(checked) => setAcceptedLegal(checked === true ? legalKey : null)}
                disabled={submitting}
                className="mt-1"
              />
              <label htmlFor={consentCheckboxId}>
                I agree to the <LegalDocumentLinks legal={legal} acknowledge />.
              </label>
            </div>
          )}
          {turnstile?.sitekey && <Turnstile key={challenge} {...turnstile} onToken={setToken} />}
          <div className="grid gap-2">
            <Button className="h-10 w-full" onClick={() => void register()} disabled={!canSubmit || submitting}>
              {submitting ? 'Creating account…' : legal ? 'Continue' : 'Create account'}
            </Button>
            {legal && (
              <Button
                variant="quiet"
                className="h-10 w-full"
                disabled={submitting}
                onClick={() => navigate(RoutePath.LOGOUT, { replace: true })}
              >
                Cancel
              </Button>
            )}
          </div>
        </div>
      ) : signInAgain ? (
        <Button onClick={() => navigate(RoutePath.LOGOUT, { replace: true })}>Sign in again</Button>
      ) : (
        <Button onClick={() => void retryAccount()}>Try again</Button>
      )}
    </SetupLayout>
  )
}
