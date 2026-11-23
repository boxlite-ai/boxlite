/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { describe, expect, it } from 'vitest'
import type { OrganizationPlan, Plan, UsagePrices } from '@/billing-api'
import { boxHourlyPrice } from './box-price'
import { boxSubscriptionValue, subscriptionValue } from './subscription-value'
const plans: Plan[] = [
  {
    id: 'starter',
    name: 'Starter',
    priceMonthlyCents: 500,
    includedQuotaCents: 2000,
    selfServe: true,
    concurrencyLimit: 4,
  },
  {
    id: 'team',
    name: 'Team',
    priceMonthlyCents: 10000,
    includedQuotaCents: 40000,
    selfServe: true,
    concurrencyLimit: 1000,
  },
]
const prices: UsagePrices = {
  schemaVersion: 1,
  currency: 'USD',
  prices: [
    { code: 'cpu', unit: 'core_hour', unitPriceCents: 5.04 },
    { code: 'mem', unit: 'gib_hour', unitPriceCents: 1.44 },
    { code: 'disk', unit: 'gib_hour', unitPriceCents: 0.018 },
  ],
}
const spec = { cpu: 1, memory: 1, disk: 10 }
const quote = boxHourlyPrice(prices, spec)!
const now = +new Date('2026-11-23')
const subscription: OrganizationPlan = {
  planId: 'starter',
  planName: 'Starter',
  status: 'active',
  cycleFrom: new Date('2026-11-01'),
  cycleTo: new Date('2026-12-01'),
  includedQuotaCents: 2000,
  quotaConsumedCents: 500,
  quotaRemainingCents: 1500,
}
const resolve = (over: Partial<OrganizationPlan> = {}) =>
  boxSubscriptionValue(plans, { ...subscription, ...over }, spec, quote, now)
describe('subscription value', () => {
  it('derives economics from the catalog and follows each metered resource', () => {
    expect(subscriptionValue(plans[0])).toEqual({ costRatio: 0.25, usageMultiple: 4 })
    expect(subscriptionValue({ ...plans[0], priceMonthlyCents: 1000 })?.costRatio).toBe(0.5)
    expect(quote.totalCents * subscriptionValue(plans[0])!.costRatio).toBeCloseTo(1.665)
    for (const key of ['cpu', 'memory', 'disk'] as const) {
      const changed = boxHourlyPrice(prices, { ...spec, [key]: spec[key] * 2 })!
      expect(changed.totalCents * subscriptionValue(plans[0])!.costRatio).toBeGreaterThan(1.665)
    }
  })
  it.each([null, 0, -1, NaN, Infinity])('does not invent a benefit for invalid quota %s', (quota) => {
    expect(subscriptionValue({ ...plans[0], includedQuotaCents: quota })).toBeNull()
  })
  it('only offers a public plan that supports the selected size', () => {
    expect(boxSubscriptionValue(plans, null, spec, quote, now).plan?.id).toBe('starter')
    expect(boxSubscriptionValue(plans, null, { ...spec, cpu: 4 }, quote, now).plan?.id).toBe('team')
    expect(boxSubscriptionValue(plans, null, { ...spec, disk: 101 }, quote, now).plan).toBeUndefined()
  })
  it('retains current benefits for scheduled cancellation', () => {
    expect(resolve({ cancelAtPeriodEnd: true }).active).toBe(true)
  })
  it.each([0, 1])('does not discount a full hour with only %s quota cents', (remaining) => {
    expect(resolve({ quotaRemainingCents: remaining }).active).toBe(false)
  })
  it.each([
    { status: 'past_due' as const },
    { entitlements: 'suspended' as const },
    { planId: 'custom' },
    { includedQuotaCents: 2500 },
    { quotaRemainingCents: null },
    { cycleTo: new Date('2026-11-20') },
  ])('declines unsupported current-plan claims: %j', (over) => expect(resolve(over).active).toBe(false))
  it('distinguishes ongoing trials from converted paid plans', () => {
    const trial = {
      startedAt: new Date('2026-11-01'),
      endsAt: new Date('2026-11-04'),
      conversionAmountCents: 500,
      currency: 'USD' as const,
    }
    for (const conversionState of ['not_attempted', 'pending', 'failed'] as const) {
      expect(resolve({ trial: { ...trial, conversionState } }).active).toBe(false)
    }
    expect(resolve({ trial: { ...trial, conversionState: 'succeeded' } }).active).toBe(true)
  })
})
