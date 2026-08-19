/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationPlan, OrganizationWallet } from '@/billing-api'
import { BRAND, Metric, Panel } from '@/components/ascii'
import { formatAmount } from '@/lib/utils'
import { cycleFacts } from './ThisCycleCard'

/**
 * Active-plan banner: a header strip naming the current plan, then the cycle
 * figures — prepaid balance, wallet spend since the last top-up, and days
 * until the cycle rolls. The plan's own quota meter and concurrency reading
 * live on the Usage tab's This Cycle card; this card keeps the identity view
 * of the same wallet and plan.
 */

export function CycleOverview({
  wallet,
  organizationPlan,
}: {
  wallet: OrganizationWallet
  organizationPlan?: OrganizationPlan | null
}) {
  const spentCents = wallet.balanceCents - wallet.ongoingBalanceCents
  const daysLeft = organizationPlan ? cycleFacts(organizationPlan, new Date()).daysLeft : null

  return (
    <Panel>
      {/* Header strip */}
      <div className="flex flex-wrap items-center gap-4 px-[22px] py-5">
        <div className="flex items-center gap-3">
          {organizationPlan && (
            <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
              <span style={{ color: BRAND }}>▸</span> Plan
            </span>
          )}
          <span className="font-mono text-[18px] font-semibold tracking-tight text-foreground">
            {organizationPlan ? organizationPlan.planName : 'No plan'}
            <span className="ml-1 animate-pulse text-muted-foreground">▮</span>
          </span>
          {organizationPlan && (
            <span className="bg-foreground px-2 py-0.5 font-mono text-[10px] uppercase tracking-[1px] text-background">
              {organizationPlan.status}
            </span>
          )}
        </div>
      </div>

      {/* Cycle figures */}
      <div className="grid grid-cols-2 gap-5 border-t border-border px-[22px] py-5 sm:flex sm:flex-row sm:gap-14">
        <Metric label="Wallet balance" value={formatAmount(wallet.ongoingBalanceCents)} sub="prepaid balance" />
        <Metric
          label="Spent this month"
          value={formatAmount(spentCents)}
          sub={`of ${formatAmount(wallet.balanceCents)} added`}
        />
        {organizationPlan && daysLeft !== null && (
          <Metric label="Renews in" value={`${daysLeft}`} sub={daysLeft === 1 ? 'day' : 'days'} />
        )}
      </div>
    </Panel>
  )
}
