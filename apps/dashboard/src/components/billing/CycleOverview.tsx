/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationPlan, OrganizationWallet, Plan } from '@/billing-api'
import { BRAND, Metric, Panel } from '@/components/ascii'
import { formatAmount, formatWholeDollars } from '@/lib/utils'

/**
 * Active-plan banner: a header strip naming the current plan, then the cycle
 * figures from the organization plan and wallet. Catalog data is joined by
 * plan id for the self-serve price and cosmetic tier label; negotiated plans
 * remain honest when they have no public catalog row.
 */

export function CycleOverview({
  wallet,
  organizationPlan,
  catalogPlan,
  catalogIndex,
}: {
  wallet: OrganizationWallet
  organizationPlan?: OrganizationPlan | null
  catalogPlan?: Plan
  catalogIndex?: number
}) {
  const tierLabel = catalogIndex === undefined ? 'Plan' : `T${catalogIndex + 1}`

  return (
    <Panel>
      {/* Header strip */}
      <div className="flex flex-wrap items-center gap-4 px-[22px] py-5">
        <div className="flex items-center gap-3">
          {organizationPlan && (
            <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
              <span style={{ color: BRAND }}>▸</span> {tierLabel}
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
        {catalogPlan?.priceMonthlyCents != null && (
          <span className="ml-auto font-mono text-[11px] text-muted-foreground">
            {formatWholeDollars(catalogPlan.priceMonthlyCents)}/mo
          </span>
        )}
      </div>

      {/* Cycle figures */}
      <div className="grid grid-cols-2 gap-5 border-t border-border px-[22px] py-5 sm:flex sm:flex-row sm:gap-14">
        <Metric
          label="Subscription"
          value={organizationPlan?.planName ?? 'No plan'}
          sub={
            catalogPlan?.priceMonthlyCents != null
              ? `${formatWholeDollars(catalogPlan.priceMonthlyCents)}/mo`
              : undefined
          }
        />
        <Metric label="Wallet balance" value={formatAmount(wallet.ongoingBalanceCents)} />
        {organizationPlan && (
          <Metric
            label="Quota consumed"
            value={formatAmount(organizationPlan.quotaConsumedCents)}
            sub={
              organizationPlan.includedQuotaCents == null
                ? 'unlimited quota'
                : `/ ${formatAmount(organizationPlan.includedQuotaCents)}`
            }
          />
        )}
      </div>
    </Panel>
  )
}
