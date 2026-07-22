/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { OrganizationSubscription } from '../entities/organization-subscription.entity'
import type { SubscriptionPlan } from '../entities/subscription-plan.entity'
import type { ProviderSubscriptionSnapshot } from '../payment/payment-provider'
import { providerPlanTransition } from './subscription-transition'

const currentPeriodStart = '2026-07-01T00:00:00.000Z'
const currentPeriodEnd = '2026-08-01T00:00:00.000Z'

function plan(id: string, rank: number): SubscriptionPlan {
  return { id, rank } as SubscriptionPlan
}

function subscription(overrides: Partial<OrganizationSubscription> = {}): OrganizationSubscription {
  return {
    pendingPlanId: null,
    pendingChangeKind: null,
    pendingPlanEffectiveAt: null,
    ...overrides,
  } as OrganizationSubscription
}

function snapshot(overrides: Partial<ProviderSubscriptionSnapshot> = {}): ProviderSubscriptionSnapshot {
  return {
    organizationId: 'organization-1',
    providerSubscriptionId: 'subscription-1',
    providerCustomerId: 'customer-1',
    providerPriceId: 'price-1',
    providerScheduleId: null,
    status: 'active',
    currentPeriodStart,
    currentPeriodEnd,
    ...overrides,
  }
}

describe('providerPlanTransition', () => {
  it('completes an immediate upgrade regardless of whether invoice.paid or subscription.updated arrives first', () => {
    expect(providerPlanTransition(subscription(), plan('starter', 1), plan('pro', 2), snapshot())).toBe('upgrade')
  })

  it('ignores a late old-plan invoice after an upgrade', () => {
    expect(providerPlanTransition(subscription(), plan('pro', 2), plan('starter', 1), snapshot())).toBe('ignore_stale')
  })

  it('ignores an old provider snapshot from a Billing Period before the current one', () => {
    expect(
      providerPlanTransition(
        subscription({ currentPeriodStart: new Date(currentPeriodEnd) }),
        plan('starter', 1),
        plan('pro', 2),
        snapshot(),
      ),
    ).toBe('ignore_stale')
  })

  it('keeps a scheduled downgrade pending before the current Billing Period ends', () => {
    expect(
      providerPlanTransition(
        subscription({
          pendingPlanId: 'starter',
          pendingChangeKind: 'downgrade',
          pendingPlanEffectiveAt: new Date(currentPeriodEnd),
        }),
        plan('pro', 2),
        plan('starter', 1),
        snapshot(),
      ),
    ).toBe('ignore_stale')
  })

  it('applies a scheduled downgrade at the next Billing Period boundary', () => {
    expect(
      providerPlanTransition(
        subscription({
          pendingPlanId: 'starter',
          pendingChangeKind: 'downgrade',
          pendingPlanEffectiveAt: new Date(currentPeriodEnd),
        }),
        plan('pro', 2),
        plan('starter', 1),
        snapshot({ currentPeriodStart: currentPeriodEnd, currentPeriodEnd: '2026-09-01T00:00:00.000Z' }),
      ),
    ).toBe('apply')
  })
})
