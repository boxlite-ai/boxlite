/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export const SUBSCRIPTION_PLAN_CODES = ['starter', 'pro', 'max'] as const
export type SubscriptionPlanCode = (typeof SUBSCRIPTION_PLAN_CODES)[number]

export type OrganizationSubscriptionStatus = 'pending' | 'active' | 'past_due' | 'canceled'
export type SubscriptionChangeKind = 'upgrade' | 'downgrade'

export interface ResourceMultipliers {
  cpu: string
  mem: string
  disk: string
  gpu: string
}

export const IDENTITY_RESOURCE_MULTIPLIERS: ResourceMultipliers = {
  cpu: '1',
  mem: '1',
  disk: '1',
  gpu: '1',
}
