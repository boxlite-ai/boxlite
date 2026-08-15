/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationSubscription } from '@/billing-api'
import { Metric, Panel, PanelNote, SectionTitle, SegmentedBar } from '@/components/ascii'
import { Skeleton } from '@/components/ui/skeleton'
import { useOwnerTierQuery, useOwnerWalletQuery } from '@/hooks/queries/billingQueries'
import { formatAmount } from '@/lib/utils'
import { differenceInCalendarDays, format } from 'date-fns'

/**
 * What the card states about a cycle, as plain values — pure in
 * (subscription, now) so the unlimited/canceled/downgrade branching is
 * testable without a DOM.
 */
export function cycleFacts(subscription: OrganizationSubscription, now: Date) {
  const daysLeft = Math.max(0, differenceInCalendarDays(subscription.cycleTo, now))
  const rollDay = format(subscription.cycleTo, 'MMM d')
  return {
    unlimited: subscription.includedQuotaCents === null,
    daysLeft,
    window: `${format(subscription.cycleFrom, 'MMM d')} – ${rollDay}`,
    note:
      subscription.status === 'canceled'
        ? `Canceled — quota stays usable until ${rollDay}, then pay-as-you-go from the wallet`
        : subscription.pendingPlanId
          ? `Downgrades to ${subscription.pendingPlanId} when the cycle rolls on ${rollDay}`
          : null,
  }
}

/**
 * The current billing cycle at a glance: quota consumed against the plan's
 * grant, the wallet that funds the overage, and when the cycle rolls. Every
 * number is the billing service's own — the subscription block on the tier
 * read and the wallet — so the meter here is the meter settlement charges by.
 * Renders nothing when the organization has no live subscription: there is no
 * cycle to show, and inventing one was the old demo's job.
 */
export function ThisCycleCard() {
  const { data: tier, isLoading } = useOwnerTierQuery()
  const { data: wallet } = useOwnerWalletQuery()
  const subscription = tier?.subscription

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
  if (!subscription) return null

  const { unlimited, daysLeft, window, note } = cycleFacts(subscription, new Date())

  return (
    <section>
      <SectionTitle title="This Cycle" count={`${subscription.planName} · ${window}`} />
      <Panel>
        <div className="flex flex-col gap-6 px-[22px] py-6 sm:flex-row sm:gap-14">
          <Metric
            label="Quota consumed"
            value={formatAmount(subscription.quotaConsumedCents)}
            sub={unlimited ? 'unlimited quota' : `of ${formatAmount(subscription.includedQuotaCents ?? 0)} included`}
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
                {formatAmount(subscription.quotaConsumedCents)} / {formatAmount(subscription.includedQuotaCents ?? 0)}
              </span>
              <SegmentedBar used={subscription.quotaConsumedCents} limit={subscription.includedQuotaCents ?? 0} />
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
