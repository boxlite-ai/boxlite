/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationPlan, OrganizationWallet } from '@/billing-api'
import { useOwnerPlanQuery, useOwnerWalletQuery } from '@/hooks/queries/billingQueries'
import { formatAmount } from '@/lib/utils'
import { cn } from '@/lib/utils'

type WalletFacts = Pick<OrganizationWallet, 'ongoingBalanceCents' | 'automaticTopUp'>
type PlanFacts = Pick<OrganizationPlan, 'quotaRemainingCents'>

export type BalanceWarning =
  /** Usage has drawn past the balance. Wrong under every plan, so it always fires. */
  | { level: 'overdrawn' }
  /** Nothing left to draw on, and no quota standing in front of the wallet. */
  | { level: 'empty' }
  /** Still funded, but under the reload point the user set for themselves. */
  | { level: 'below-threshold'; thresholdDollars: number; targetDollars: number }

/**
 * Which low-balance warning the wallet has earned, if any.
 *
 * The threshold tier alone used to be the whole rule, which made the banner
 * unreachable in the case that needs it most: the reload threshold lives behind
 * a linked card, so an account that never linked one could run its balance
 * negative in silence. Overdrawn and empty are therefore judged on the balance
 * itself, with no configuration to opt into.
 *
 * Quota matters only for `empty`: a plan with quota left is *expected* to sit at
 * a $0 wallet, and warning there would be noise on a healthy account. Overdrawn
 * is not excused by quota — the draw already happened.
 *
 * Thresholds are wire dollars; balances are cents.
 */
export function balanceWarning(wallet: WalletFacts | undefined, plan?: PlanFacts | null): BalanceWarning | null {
  if (!wallet) return null

  const balanceCents = wallet.ongoingBalanceCents
  if (balanceCents < 0) return { level: 'overdrawn' }

  // `null` remaining is an unlimited/negotiated grant, not an exhausted one.
  const quotaRemainingCents = plan?.quotaRemainingCents
  const quotaCovers = quotaRemainingCents === null || (quotaRemainingCents ?? 0) > 0
  if (balanceCents === 0 && !quotaCovers) return { level: 'empty' }

  const thresholdDollars = wallet.automaticTopUp?.thresholdAmount
  const targetDollars = wallet.automaticTopUp?.targetAmount
  // A zeroed threshold means auto-reload is off (WalletSection's convention),
  // not "warn below $0" — that case is already covered above.
  if (!thresholdDollars || !targetDollars) return null
  if (balanceCents / 100 >= thresholdDollars) return null

  return { level: 'below-threshold', thresholdDollars, targetDollars }
}

const COPY: Record<BalanceWarning['level'], { title: (balance: string) => string; destructive: boolean }> = {
  overdrawn: { title: (balance) => `Wallet overdrawn — ${balance}`, destructive: true },
  empty: { title: () => 'Wallet empty — $0.00 remaining', destructive: false },
  'below-threshold': { title: (balance) => `Wallet balance low — ${balance} remaining`, destructive: false },
}

function detail(warning: BalanceWarning): string {
  switch (warning.level) {
    case 'overdrawn':
      return 'Usage has already drawn past your balance. Top up to settle it.'
    case 'empty':
      return 'Your included quota is spent, so further usage draws on the wallet. Top up to keep going.'
    case 'below-threshold':
      return `Auto-reload brings the balance to $${warning.targetDollars.toFixed(2)} when it drops below $${warning.thresholdDollars.toFixed(2)}.`
  }
}

/**
 * Warns on a wallet that cannot fund what comes next. Suspension states are the
 * global banner's job (useSuspensionBanner), not repeated here.
 */
export function BalanceLowBanner({ onGoToWallet }: { onGoToWallet: () => void }) {
  const { data: wallet } = useOwnerWalletQuery()
  const { data: plan } = useOwnerPlanQuery()
  const warning = balanceWarning(wallet, plan)
  if (!wallet || !warning) return null

  const { title, destructive } = COPY[warning.level]
  const tone = destructive ? 'destructive' : 'warning'

  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-4 border px-[22px] py-4',
        destructive ? 'border-destructive/60 bg-destructive/10' : 'border-warning/60 bg-warning/10',
      )}
    >
      <div className="flex flex-col gap-1">
        <span
          className={cn(
            'flex items-center gap-2 font-mono text-[12px] font-semibold',
            destructive ? 'text-destructive' : 'text-warning',
          )}
        >
          <span className="size-[9px]" style={{ background: `hsl(var(--${tone}))` }} />
          {title(formatAmount(wallet.ongoingBalanceCents))}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">{detail(warning)}</span>
      </div>
      <button
        className={cn(
          'border px-4 py-2 font-mono text-[12px] transition-colors',
          destructive
            ? 'border-destructive/60 text-destructive hover:bg-destructive/10'
            : 'border-warning/60 text-warning hover:bg-warning/10',
        )}
        onClick={onGoToWallet}
      >
        Top up →
      </button>
    </div>
  )
}
