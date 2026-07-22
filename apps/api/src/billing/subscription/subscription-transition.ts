/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { OrganizationSubscription } from '../entities/organization-subscription.entity'
import type { SubscriptionPlan } from '../entities/subscription-plan.entity'
import type { ProviderSubscriptionSnapshot } from '../payment/payment-provider'

export type ProviderPlanTransition = 'upgrade' | 'apply' | 'ignore_stale'

export function providerPlanTransition(
  subscription: OrganizationSubscription,
  currentPlan: SubscriptionPlan,
  providerPlan: SubscriptionPlan,
  snapshot: ProviderSubscriptionSnapshot,
): ProviderPlanTransition {
  if (subscription.currentPeriodStart && new Date(snapshot.currentPeriodStart) < subscription.currentPeriodStart) {
    return 'ignore_stale'
  }
  if (providerPlan.rank > currentPlan.rank) return 'upgrade'
  if (providerPlan.rank === currentPlan.rank) return 'apply'

  const effectiveScheduledDowngrade =
    subscription.pendingChangeKind === 'downgrade' &&
    subscription.pendingPlanId === providerPlan.id &&
    !!subscription.pendingPlanEffectiveAt &&
    new Date(snapshot.currentPeriodStart) >= subscription.pendingPlanEffectiveAt
  return effectiveScheduledDowngrade ? 'apply' : 'ignore_stale'
}
