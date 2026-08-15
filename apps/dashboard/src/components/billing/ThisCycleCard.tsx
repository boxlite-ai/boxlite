/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationPlan } from '@/billing-api'
import { Metric, Panel, PanelNote, SectionTitle, SegmentedBar } from '@/components/ascii'
import { Skeleton } from '@/components/ui/skeleton'
import { useOwnerTierQuery, useOwnerWalletQuery } from '@/hooks/queries/billingQueries'
import { formatAmount } from '@/lib/utils'
import { differenceInCalendarDays, format } from 'date-fns'

/**
 * What the card states about a cycle, as plain values — pure in
 * (plan, now) so the unlimited/canceled/downgrade branching is
 * testable without a DOM.
 */
export function cycleFacts(plan: OrganizationPlan, now: Date) {
  const daysLeft = Math.max(0, differenceInCalendarDays(plan.cycleTo, now))
  const rollDay = format(plan.cycleTo, 'MMM d')
  return {
    unlimited: plan.includedQuotaCents === null,
    daysLeft,
    window: `${format(plan.cycleFrom, 'MMM d')} – ${rollDay}`,
    note:
      plan.status === 'canceled'
        ? `Canceled — quota stays usable until ${rollDay}, then pay-as-you-go from the wallet`
        : plan.pendingPlanId
          ? `Downgrades to ${plan.pendingPlanId} when the cycle rolls on ${rollDay}`
          : null,
  }
}

/**
 * The current billing cycle at a glance: quota consumed against the plan's
 * grant, the wallet that funds the overage, and when the cycle rolls. Every
 * number is the billing service's own — the plan block on the tier
 * read and the wallet — so the meter here is the meter settlement charges by.
 * Renders nothing when the organization has no live plan: there is no
 * cycle to show, and inventing one was the old demo's job.
 */
export function ThisCycleCard() {
  const { data: tier, isLoading } = useOwnerTierQuery()
  const { data: wallet } = useOwnerWalletQuery()
  const plan = tier?.plan

  if (isLoading) {
    return (
      <section>
        <SectionTitle title="This Cycle" />
        <Panel className="px-[22px] py-6">
          <Skeleton className="h-[72px] w-full" />
        </Panel>
      </section>
    )
  }
  if (!plan) return null

  const { unlimited, daysLeft, window, note } = cycleFacts(plan, new Date())

  return (
    <section>
      <SectionTitle title="This Cycle" count={`${plan.planName} · ${window}`} />
      <Panel>
        <div className="flex flex-col gap-6 px-[22px] py-6 sm:flex-row sm:gap-14">
          <Metric
            label="Quota consumed"
            value={formatAmount(plan.quotaConsumedCents)}
            sub={unlimited ? 'unlimited quota' : `of ${formatAmount(plan.includedQuotaCents ?? 0)} included`}
          />
          {wallet && (
            <Metric label="Wallet balance" value={formatAmount(wallet.ongoingBalanceCents)} sub="drawn after quota" />
          )}
          <Metric label="Cycle ends in" value={String(daysLeft)} sub={daysLeft === 1 ? 'day' : 'days'} />
        </div>

        {!unlimited && (
          <div className="border-t border-border px-[22px] py-4">
            <div className="flex items-center gap-4 font-mono text-[12px]">
              <span className="w-[100px] shrink-0 uppercase tracking-[0.5px] text-muted-foreground">Quota used</span>
              <span className="w-[140px] shrink-0 tabular-nums text-foreground">
                {formatAmount(plan.quotaConsumedCents)} / {formatAmount(plan.includedQuotaCents ?? 0)}
              </span>
              <SegmentedBar used={plan.quotaConsumedCents} limit={plan.includedQuotaCents ?? 0} />
            </div>
            <PanelNote>Included in plan · resets each cycle · unused quota does not carry over</PanelNote>
          </div>
        )}

        {note && (
          <div className="border-t border-border px-[22px] py-4">
            <PanelNote>{note}</PanelNote>
          </div>
        )}
      </Panel>
    </section>
  )
}
