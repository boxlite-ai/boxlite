/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * The organization's subscription plan and its cycle quota, riding the tier
 * response. `includedQuotaCents`/`quotaRemainingCents` of null mean unlimited
 * (a negotiated deal), not zero.
 */
export type OrganizationSubscription = {
  planId: string
  planName: string
  status: 'active' | 'canceled'
  cycleFrom: Date
  cycleTo: Date
  includedQuotaCents: number | null
  quotaConsumedCents: number
  quotaRemainingCents: number | null
  pendingPlanId?: string
}

export type OrganizationTier = {
  tier: number
  largestSuccessfulPaymentDate?: Date
  largestSuccessfulPaymentCents: number
  expiresAt?: Date
  hasVerifiedBusinessEmail: boolean
  /** Absent when the organization has no live subscription. */
  subscription?: OrganizationSubscription
}
