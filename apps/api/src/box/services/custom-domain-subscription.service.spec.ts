/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { requireDomainSubscription, subscriptionExpiry } from './custom-domain-subscription.service'

describe('custom domain subscription policy', () => {
  const now = Date.parse('2026-11-04T00:00:00Z')
  const future = new Date(now + 3 * 86_400_000).toISOString()

  it.each([
    { status: 'active' },
    { status: 'active', entitlements: 'active', cancelAtPeriodEnd: true },
    { status: 'past_due', entitlements: 'active' },
  ])('grants effective paid access for %j for at most one minute', (plan) => {
    expect(subscriptionExpiry({ plan: { ...plan, cycleTo: future } }, now)).toBe(now + 60_000)
  })

  it('clips access to the paid cycle and rejects an expired cycle', () => {
    const cycleTo = new Date(now + 20_000).toISOString()
    expect(subscriptionExpiry({ plan: { status: 'active', cycleTo } }, now)).toBe(now + 20_000)
    expect(subscriptionExpiry({ plan: { status: 'active', cycleTo } }, now + 20_000)).toBeNull()
  })

  it.each([
    {},
    { plan: { status: 'canceled', cycleTo: future } },
    { plan: { status: 'active', entitlements: 'suspended', cycleTo: future } },
    { plan: { status: 'past_due', cycleTo: future } },
  ])('does not grant access from %j', (response) => {
    expect(subscriptionExpiry(response, now)).toBeNull()
  })

  it.each([
    null,
    [],
    { plan: null },
    { plan: { planId: 'paid' } },
    { plan: { status: 'trialing', cycleTo: future } },
    { plan: { status: 'active' } },
    { plan: { status: 'active', cycleTo: 'invalid' } },
    { plan: { status: 'active', entitlements: 'unknown', cycleTo: future } },
  ])('fails closed for malformed or unknown eligibility %j', (response) => {
    expect(() => subscriptionExpiry(response, now)).toThrow()
  })

  it('distinguishes denied access from temporary inability to check eligibility', () => {
    expect(() => requireDomainSubscription('active')).not.toThrow()
    for (const [status, http, code] of [
      ['required', 403, 'subscription_required'],
      ['unavailable', 409, 'subscription_not_ready'],
    ] as const) {
      try {
        requireDomainSubscription(status)
        throw new Error('expected rejection')
      } catch (error) {
        expect(error).toMatchObject({ status: http, response: { code, message: expect.any(String) } })
      }
    }
  })
})
