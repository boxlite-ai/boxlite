/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import type { OrganizationPlan, Plan } from '@/billing-api'
import type { BoxHourlyPrice, BoxSpec } from './box-price'
import { PLAN_BOX_LIMITS, planTierIndex } from '@/components/billing/planBenefits'

/** Catalog economics, not the ledger debit rate or the customer's paid invoice. */
export function subscriptionValue(plan: Plan | undefined) {
  const price = plan?.priceMonthlyCents
  const quota = plan?.includedQuotaCents
  if (
    !plan?.selfServe ||
    price == null ||
    quota == null ||
    !Number.isFinite(price) ||
    !Number.isFinite(quota) ||
    price <= 0 ||
    quota <= price
  )
    return null
  return { costRatio: price / quota, usageMultiple: quota / price }
}

export function boxSubscriptionValue(
  plans: Plan[],
  subscription: OrganizationPlan | null,
  spec: BoxSpec,
  quote: BoxHourlyPrice,
  now = Date.now(),
) {
  if (subscription?.trial && subscription.trial.conversionState !== 'succeeded') {
    return { active: false, note: 'Trial usage · paid-plan estimates do not apply.' }
  }
  if (subscription === null || subscription.status === 'canceled') {
    // Public limits share their source with Billing's benefits table. Unknown tiers cannot be recommended.
    const plan = [...plans]
      .sort((a, b) => (a.priceMonthlyCents ?? Infinity) - (b.priceMonthlyCents ?? Infinity))
      .find((candidate) => {
        const limits = PLAN_BOX_LIMITS[planTierIndex(candidate.name)]
        return (
          subscriptionValue(candidate) &&
          limits &&
          spec.cpu <= limits.cpu &&
          spec.memory <= limits.memory &&
          spec.disk <= limits.disk
        )
      })
    return { plan, active: false, note: undefined }
  }
  if (subscription.status !== 'active' || subscription.entitlements === 'suspended') {
    return { active: false, note: 'Plan coverage is not confirmed.' }
  }
  if (!(+new Date(subscription.cycleFrom) <= now && now < +new Date(subscription.cycleTo))) {
    return { active: false, note: 'Plan cycle needs refreshing.' }
  }
  const remaining = subscription.quotaRemainingCents
  if (remaining != null && Number.isFinite(remaining) && remaining < quote.totalCents) {
    return {
      active: false,
      note:
        remaining <= 0
          ? 'Included usage used up · PAYG rates apply.'
          : 'Included usage covers less than one hour · the rest uses PAYG rates.',
    }
  }
  const plan = plans.find(
    (candidate) =>
      candidate.id === subscription.planId &&
      candidate.includedQuotaCents === subscription.includedQuotaCents &&
      subscriptionValue(candidate),
  )
  if (!plan || remaining == null || !Number.isFinite(remaining)) {
    return { active: false, note: 'Plan-specific effective cost is unavailable.' }
  }
  return { plan, active: true, note: undefined }
}

export const formatUsageMultiple = (multiple: number) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Math.floor(multiple * 100) / 100)
