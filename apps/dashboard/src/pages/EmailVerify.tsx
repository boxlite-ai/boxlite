/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { AsciiButton } from '@/components/ascii'
import { Logo } from '@/assets/Logo'
import { RoutePath } from '@/enums/RoutePath'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { Check, Loader2, X } from '@/components/ui/icon'
import { useState, useEffect, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

/**
 * Verifies the URL token, selects its organization, and schedules a billing redirect.
 * A failed verification offers a manual billing action; unmount cancels the redirect timer.
 */
export default function EmailVerify() {
  const { organizationId, email, token } = useParams<{
    organizationId: string
    email: string
    token: string
  }>()
  const navigate = useNavigate()
  const [verificationStatus, setVerificationStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [errorMessage, setErrorMessage] = useState<string>('')
  const { onSelectOrganization } = useSelectedOrganization()
  const { billingApi } = useApi()

  const attempts = useRef(new Map<string, Promise<boolean>>())
  const verified = useRef(false)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    if (!organizationId || !email || !token) {
      setVerificationStatus('error')
      setErrorMessage('Invalid verification link')
      return
    }
    const key = JSON.stringify([organizationId, email, token])
    // Share the one-time verification across effect replay and selection updates.
    if (!attempts.current.has(key)) {
      attempts.current.set(
        key,
        billingApi.verifyOrganizationEmail(organizationId, email, token).then(() => {
          verified.current = true
          return onSelectOrganization(organizationId)
        }),
      )
    }
    void attempts.current
      .get(key)!
      .then((selected) => {
        if (cancelled) return
        if (!selected) throw new Error('Organization selection failed')
        setVerificationStatus('success')
        timer = setTimeout(() => navigate(RoutePath.BILLING), 1000)
      })
      .catch(() => {
        if (cancelled) return
        setVerificationStatus('error')
        setErrorMessage(
          verified.current
            ? 'Email verified, but we could not open the organization. Continue to billing and select your organization.'
            : 'An error occurred while verifying your email',
        )
      })
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [organizationId, email, token, billingApi, navigate, onSelectOrganization])

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 font-sans text-body">
      <div className="w-full max-w-[420px] border border-border bg-card p-8 text-center">
        <div className="mb-5 flex justify-center">
          <Logo />
        </div>
        {verificationStatus === 'loading' && (
          <>
            <div className="mb-4 flex justify-center">
              <Loader2 className="size-7 animate-spin text-muted-foreground" />
            </div>
            <div className="text-em font-bold tracking-[-0.3px]">Verifying your email</div>
            <p className="mt-2 text-meta text-muted-foreground">Please wait while we verify your email address…</p>
          </>
        )}
        {verificationStatus === 'success' && (
          <>
            <div className="mb-4 flex justify-center">
              <span
                className="flex size-12 items-center justify-center rounded-full"
                style={{ background: 'hsl(var(--success) / 0.15)' }}
              >
                <Check className="size-6 text-success" strokeWidth={2.5} />
              </span>
            </div>
            <div className="text-em font-bold tracking-[-0.3px] text-success">Email verified</div>
            <p className="mt-2 text-meta text-muted-foreground">
              Your email has been verified. Redirecting to billing shortly…
            </p>
          </>
        )}
        {verificationStatus === 'error' && (
          <>
            <div className="mb-4 flex justify-center">
              <span
                className="flex size-12 items-center justify-center rounded-full"
                style={{ background: 'hsl(var(--destructive) / 0.15)' }}
              >
                <X className="size-6 text-destructive" strokeWidth={2.5} />
              </span>
            </div>
            <div className="text-em font-bold tracking-[-0.3px] text-destructive">Verification failed</div>
            <p className="mt-2 text-meta text-muted-foreground">{errorMessage}</p>
            <AsciiButton variant="primary" className="mt-5" type="button" onClick={() => navigate(RoutePath.BILLING)}>
              Go to billing
            </AsciiButton>
          </>
        )}
      </div>
    </div>
  )
}
