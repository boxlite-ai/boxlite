/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationTier, OrganizationWallet, Tier } from '@/billing-api'
import { BRAND, Metric, Panel } from '@/components/ascii'
import { formatAmount } from '@/lib/utils'

/**
 * Active-plan banner: a header strip naming the current tier, then the cycle
 * figures — prepaid balance, wallet spend since the last top-up, and tier
 * expiry. The plan's own quota meter and billing cycle live on the
 * Usage tab's This Cycle card (the `plan` block on the tier read);
 * this card keeps the tier-ladder view of the same wallet.
 */

function daysUntil(date: Date): number {
  return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 86_400_000))
}

export function CycleOverview({
  wallet,
  organizationTier,
  currentTier,
}: {
  wallet: OrganizationWallet
  organizationTier?: OrganizationTier | null
  currentTier?: Tier
}) {
  const spentCents = wallet.balanceCents - wallet.ongoingBalanceCents
  const expiresInDays = organizationTier?.expiresAt ? daysUntil(organizationTier.expiresAt) : null
  const ceilings = currentTier
    ? `${currentTier.tierLimit.concurrentCPU} vCPU · ${currentTier.tierLimit.concurrentRAMGiB} GiB RAM · ${currentTier.tierLimit.concurrentDiskGiB} GiB disk`
    : null

  return (
    <Panel>
      {/* Header strip */}
      <div className="flex flex-wrap items-center gap-4 px-[22px] py-5">
        <div className="flex items-center gap-3">
          {organizationTier && (
            <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
              <span style={{ color: BRAND }}>▸</span> T{organizationTier.tier}
            </span>
          )}
          <span className="font-mono text-[18px] font-semibold tracking-tight text-foreground">
            {organizationTier ? `Tier ${organizationTier.tier}` : 'No tier'}
            <span className="ml-1 animate-pulse text-muted-foreground">▮</span>
          </span>
          {organizationTier && (
            <span className="bg-foreground px-2 py-0.5 font-mono text-[10px] uppercase tracking-[1px] text-background">
              active
            </span>
          )}
        </div>
        {ceilings && <span className="ml-auto font-mono text-[11px] text-muted-foreground">{ceilings}</span>}
      </div>

      {/* Cycle figures */}
      <div className="grid grid-cols-2 gap-5 border-t border-border px-[22px] py-5 sm:flex sm:flex-row sm:gap-14">
        <Metric label="Wallet balance" value={formatAmount(wallet.ongoingBalanceCents)} sub="prepaid balance" />
        <Metric
          label="Spent this month"
          value={formatAmount(spentCents)}
          sub={`of ${formatAmount(wallet.balanceCents)} added`}
        />
        {organizationTier && (
          <Metric
            label={expiresInDays === null ? 'Tier' : 'Tier expires in'}
            value={expiresInDays === null ? `T${organizationTier.tier}` : `${expiresInDays}`}
            sub={expiresInDays === null ? 'no expiry set' : 'days'}
          />
        )}
      </div>
    </Panel>
  )
}
