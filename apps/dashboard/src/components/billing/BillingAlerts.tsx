/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { SparklesIcon, TriangleAlertIcon } from '@/components/ui/icon'
import { useOwnerWalletQuery } from '@/hooks/queries/billingQueries'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { ReactNode } from 'react'
import { useAuth } from 'react-oidc-context'

/**
 * Page-level billing state banners. Every message is derived from a state the
 * current wallet or identity contract actually exposes.
 */
export function BillingAlerts() {
  const { selectedOrganization } = useSelectedOrganization()
  const { user } = useAuth()
  const wallet = useOwnerWalletQuery().data

  if (!wallet) {
    return null
  }

  return (
    <>
      {user && !user.profile.email_verified && (
        <StatusBanner tone="warning" icon={<TriangleAlertIcon className="size-4 shrink-0" />} title="Verify your email">
          Please verify your email address to complete your account setup.
          <br />A verification email was sent to you.
        </StatusBanner>
      )}
      {user &&
        !wallet.creditCardConnected &&
        user.profile.email_verified &&
        selectedOrganization?.isDefaultForAuthenticatedUser && (
          <StatusBanner tone="neutral" icon={<SparklesIcon className="size-4 shrink-0" />}>
            Connect a credit card to enable wallet top-ups.
          </StatusBanner>
        )}
    </>
  )
}

/** Bordered status banner in the terminal language — tone drives border/text colour only. */
function StatusBanner({
  tone,
  icon,
  title,
  children,
}: {
  tone: 'warning' | 'destructive' | 'neutral'
  icon?: ReactNode
  title?: string
  children: ReactNode
}) {
  const toneClass = {
    warning: 'border-warning/60 bg-warning/10 text-warning',
    destructive: 'border-destructive/60 bg-destructive/10 text-destructive',
    neutral: 'border-border bg-card text-foreground',
  }[tone]

  return (
    <div className={`border px-[22px] py-4 ${toneClass}`}>
      <div className="flex items-start gap-2">
        {icon}
        <div className="flex flex-col gap-1">
          {title && <span className="font-mono text-[12px] font-semibold">{title}</span>}
          <span className="font-mono text-[11px] leading-relaxed text-muted-foreground">{children}</span>
        </div>
      </div>
    </div>
  )
}
