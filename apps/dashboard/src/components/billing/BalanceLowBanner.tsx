/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationWallet } from '@/billing-api'
import { useOwnerWalletQuery } from '@/hooks/queries/billingQueries'
import { formatAmount } from '@/lib/utils'

/**
 * The banner fires only against the auto-reload threshold the user set —
 * the one honest low-balance line that exists. A zeroed threshold means
 * auto-reload is disabled (WalletSection's own convention), not "warn below
 * $0". Thresholds are wire dollars; the balance is cents.
 */
export function lowBalance(
  wallet: Pick<OrganizationWallet, 'ongoingBalanceCents' | 'automaticTopUp'> | undefined,
): { thresholdDollars: number; targetDollars: number } | null {
  const threshold = wallet?.automaticTopUp?.thresholdAmount
  const target = wallet?.automaticTopUp?.targetAmount
  if (!wallet || !threshold || !target) return null
  if (wallet.ongoingBalanceCents / 100 >= threshold) return null
  return { thresholdDollars: threshold, targetDollars: target }
}

/**
 * Warns when the wallet has fallen below the user's own auto-reload
 * threshold. Suspension states are the global banner's job
 * (useSuspensionBanner), not repeated here.
 */
export function BalanceLowBanner({ onGoToWallet }: { onGoToWallet: () => void }) {
  const { data: wallet } = useOwnerWalletQuery()
  const low = lowBalance(wallet)
  if (!wallet || !low) return null

  return (
    <div className="flex flex-wrap items-center justify-between gap-4 border border-warning/60 bg-warning/10 px-[22px] py-4">
      <div className="flex flex-col gap-1">
        <span className="flex items-center gap-2 font-mono text-[12px] font-semibold text-warning">
          <span className="size-[9px]" style={{ background: 'hsl(var(--warning))' }} />
          Wallet balance low — {formatAmount(wallet.ongoingBalanceCents)} remaining
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          Auto-reload brings the balance to ${low.targetDollars.toFixed(2)} when it drops below $
          {low.thresholdDollars.toFixed(2)}.
        </span>
      </div>
      <button
        className="border border-warning/60 px-4 py-2 font-mono text-[12px] text-warning transition-colors hover:bg-warning/10"
        onClick={onGoToWallet}
      >
        Top up →
      </button>
    </div>
  )
}
