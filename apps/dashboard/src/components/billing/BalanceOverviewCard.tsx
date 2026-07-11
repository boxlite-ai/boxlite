/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { ReactNode } from 'react'
import { BILLING_BRAND, MatrixAmount } from './ascii'

function centsToDisplay(cents: string): string {
  if (!/^-?\d+$/.test(cents)) return '-'
  const value = BigInt(cents)
  const sign = value < 0n ? '-' : ''
  const absolute = value < 0n ? -value : value
  return `${sign}${(absolute / 100n).toLocaleString('en-US')}.${(absolute % 100n).toString().padStart(2, '0')}`
}

function Metric({ label, cents }: { label: string; cents: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <span className="font-mono text-[10px] uppercase text-muted-foreground">
        <span style={{ color: BILLING_BRAND }}>▸</span> {label}
      </span>
      <MatrixAmount prefix="$" value={centsToDisplay(cents)} size="lg" />
    </div>
  )
}

export function BalanceOverviewCard({
  totalBalanceCents,
  freeBalanceCents,
  paidBalanceCents,
  spentThisMonthCents,
  freeExpiresAt,
  paymentMethod,
}: {
  totalBalanceCents: string
  freeBalanceCents: string
  paidBalanceCents: string
  spentThisMonthCents: string
  freeExpiresAt: string | null
  paymentMethod: ReactNode
}) {
  const expiry = freeExpiresAt ? new Date(freeExpiresAt) : null
  const expiryLabel = expiry && !Number.isNaN(expiry.getTime()) ? ` · expires ${expiry.toLocaleDateString()}` : ''

  return (
    <div data-testid="billing-balance-overview" className="flex flex-col border border-border bg-card">
      <div className="grid gap-8 px-[22px] py-6 sm:grid-cols-2 sm:gap-16">
        <Metric label="Current balance" cents={totalBalanceCents} />
        <Metric label="Spent this month" cents={spentThisMonthCents} />
      </div>
      <div className="flex flex-col gap-1 border-t border-border px-[22px] py-3 font-mono text-[11px] text-muted-foreground sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
        <span>
          <span className="text-foreground">Free balance ${centsToDisplay(freeBalanceCents)}</span>
          {expiryLabel}
        </span>
        <span className="hidden text-border sm:inline">|</span>
        <span className="text-foreground">Paid balance ${centsToDisplay(paidBalanceCents)}</span>
      </div>
      {paymentMethod}
    </div>
  )
}
