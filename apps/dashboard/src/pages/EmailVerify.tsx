/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Logo } from '@/assets/Logo'
import { RoutePath } from '@/enums/RoutePath'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { Check, Loader2, X } from '@/components/ui/icon'
import { useState, useEffect, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

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

  const redirectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Unmount only, which is why it is its own effect. The verify effect below re-runs whenever
  // onSelectOrganization changes identity — and selecting an organization changes it, so
  // clearing the timer in that effect's cleanup would cancel the redirect on the success path.
  useEffect(() => () => clearTimeout(redirectTimer.current), [])

  useEffect(() => {
    const verifyEmail = async () => {
      if (!organizationId || !email || !token) {
        setVerificationStatus('error')
        setErrorMessage('Invalid verification link')
        return
      }

      try {
        await billingApi.verifyOrganizationEmail(organizationId, email, token)
        setVerificationStatus('success')
        onSelectOrganization(organizationId)
        // This effect re-runs whenever a dependency's identity changes, and each run reaches
        // here, so drop the previous timer rather than orphaning it.
        clearTimeout(redirectTimer.current)
        redirectTimer.current = setTimeout(() => {
          navigate(RoutePath.BILLING)
        }, 1000)
      } catch (error) {
        setVerificationStatus('error')
        setErrorMessage('An error occurred while verifying your email')
      }
    }

    verifyEmail()
  }, [organizationId, email, token, billingApi, navigate, onSelectOrganization])

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 font-mono text-[13px]">
      <div className="w-full max-w-[420px] border border-border bg-card p-8 text-center">
        <div className="mb-5 flex justify-center">
          <Logo />
        </div>
        {verificationStatus === 'loading' && (
          <>
            <div className="mb-4 flex justify-center">
              <Loader2 className="size-7 animate-spin text-muted-foreground" />
            </div>
            <div className="text-[16px] font-bold tracking-[-0.3px]">Verifying your email</div>
            <p className="mt-2 text-[12.5px] text-muted-foreground">Please wait while we verify your email address…</p>
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
            <div className="text-[16px] font-bold tracking-[-0.3px] text-success">Email verified</div>
            <p className="mt-2 text-[12.5px] text-muted-foreground">
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
            <div className="text-[16px] font-bold tracking-[-0.3px] text-destructive">Verification failed</div>
            <p className="mt-2 text-[12.5px] text-muted-foreground">{errorMessage}</p>
            <button
              type="button"
              onClick={() => navigate(RoutePath.BILLING)}
              className="mt-5 bg-primary px-5 py-[11px] text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-85"
            >
              Go to billing
            </button>
          </>
        )}
      </div>
    </div>
  )
}
