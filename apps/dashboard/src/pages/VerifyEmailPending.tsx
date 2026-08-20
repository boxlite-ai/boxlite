/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { LogoText } from '@/assets/Logo'
import { EmailVerificationRequestError, resendEmailVerification } from '@/api/emailVerificationApi'
import { Button } from '@/components/ui/button'
import { MailIcon } from '@/components/ui/icon'
import { Spinner } from '@/components/ui/spinner'
import { RoutePath } from '@/enums/RoutePath'
import { useConfig } from '@/hooks/useConfig'
import {
  clearPendingEmailVerification,
  consumeEmailVerificationAutoResend,
  getPendingEmailVerificationReturnTo,
} from '@/lib/auth-session'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { Navigate, useNavigate } from 'react-router-dom'

const RESEND_COOLDOWN_SECONDS = 60

type DeliveryState = 'idle' | 'sending' | 'sent' | 'error'

const VerifyEmailPending: React.FC = () => {
  const config = useConfig()
  const navigate = useNavigate()
  const { isAuthenticated, isLoading, user, signinRedirect, signinSilent } = useAuth()
  const [deliveryState, setDeliveryState] = useState<DeliveryState>('idle')
  const [message, setMessage] = useState('')
  const [cooldownSeconds, setCooldownSeconds] = useState(0)
  const [isChecking, setIsChecking] = useState(false)
  const isSending = useRef(false)
  const returnTo = getPendingEmailVerificationReturnTo()
  const accessToken = user?.access_token

  useEffect(() => {
    if (cooldownSeconds <= 0) {
      return
    }
    const timer = window.setInterval(() => {
      setCooldownSeconds((seconds) => Math.max(0, seconds - 1))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [cooldownSeconds])

  const resend = useCallback(async () => {
    if (!accessToken || isSending.current || cooldownSeconds > 0) {
      return
    }

    isSending.current = true
    setDeliveryState('sending')
    setMessage('Sending a new verification email…')
    try {
      await resendEmailVerification(config.apiUrl, accessToken)
      setDeliveryState('sent')
      setMessage('Verification email sent. Check your inbox for a new link.')
      setCooldownSeconds(RESEND_COOLDOWN_SECONDS)
    } catch (error) {
      const requestError = error instanceof EmailVerificationRequestError ? error : undefined
      setDeliveryState('error')
      setMessage(requestError?.message || 'Unable to send a verification email. Please try again.')
      if (requestError?.status === 429) {
        setCooldownSeconds(requestError.retryAfterSeconds || RESEND_COOLDOWN_SECONDS)
      }
    } finally {
      isSending.current = false
    }
  }, [accessToken, config.apiUrl, cooldownSeconds])

  useEffect(() => {
    if (accessToken && consumeEmailVerificationAutoResend()) {
      void resend()
    }
  }, [accessToken, resend])

  useEffect(() => {
    if (isAuthenticated && user && (!config.oidc.emailVerificationRequired || user.profile.email_verified === true)) {
      clearPendingEmailVerification()
    }
  }, [config.oidc.emailVerificationRequired, isAuthenticated, user])

  const confirmVerification = async () => {
    if (isChecking) {
      return
    }
    setIsChecking(true)
    setMessage('Checking your verification status…')
    try {
      const refreshedUser = await signinSilent()
      if (refreshedUser?.profile.email_verified === true) {
        clearPendingEmailVerification()
        navigate(returnTo, { replace: true })
        return
      }
      setDeliveryState('error')
      setMessage('Your email is not verified yet. Open the latest email and try again.')
    } catch {
      try {
        await signinRedirect({ state: { returnTo } })
      } catch {
        setDeliveryState('error')
        setMessage('Unable to refresh your session. Please try again.')
      }
    } finally {
      setIsChecking(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <Spinner />
      </div>
    )
  }
  if (!isAuthenticated || !user) {
    return <Navigate to={RoutePath.LANDING} replace />
  }
  if (!config.oidc.emailVerificationRequired || user.profile.email_verified === true) {
    return <Navigate to={returnTo} replace />
  }

  const resendLabel =
    cooldownSeconds > 0
      ? `Resend in ${cooldownSeconds}s`
      : deliveryState === 'sending'
        ? 'Sending…'
        : 'Resend verification email'

  return (
    <main className="flex min-h-svh items-center justify-center px-5 py-10">
      <section className="w-full max-w-[520px] border border-border bg-background px-6 py-8 sm:px-10 sm:py-10">
        <LogoText className="h-8 w-auto" />
        <div className="mt-10 flex size-11 items-center justify-center border border-brand/40 bg-brand/10 text-brand">
          <MailIcon className="size-5" aria-hidden="true" />
        </div>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight">Verify your email</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          We sent a verification link to{' '}
          <span className="font-medium text-foreground">{user.profile.email || 'your email address'}</span>. Verify this
          address before continuing to the Dashboard.
        </p>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          If the link expired or never arrived, request a new one below.
        </p>

        <div className="mt-7 flex flex-col gap-3">
          <Button
            type="button"
            size="lg"
            onClick={confirmVerification}
            disabled={isChecking || deliveryState === 'sending'}
          >
            {isChecking && <Spinner className="size-4" />}
            I&apos;ve verified my email
          </Button>
          <Button
            type="button"
            size="lg"
            variant="outline"
            onClick={resend}
            disabled={deliveryState === 'sending' || cooldownSeconds > 0}
            aria-busy={deliveryState === 'sending'}
          >
            {deliveryState === 'sending' && <Spinner className="size-4" />}
            {resendLabel}
          </Button>
        </div>

        <div
          role="status"
          aria-live="polite"
          className={`mt-5 min-h-5 font-mono text-[12px] ${deliveryState === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}
        >
          {message}
        </div>

        <button
          type="button"
          className="mt-7 text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          onClick={() => navigate(RoutePath.LOGOUT)}
        >
          Sign out and use another account
        </button>
      </section>
    </main>
  )
}

export default VerifyEmailPending
