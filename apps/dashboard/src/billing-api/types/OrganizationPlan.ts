/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * The organization's plan and its cycle quota — the whole body of
 * `GET organization/:id/plan`. `includedQuotaCents`/`quotaRemainingCents` of
 * null mean unlimited (a negotiated deal), not zero. `null` overall means no
 * live plan: never subscribed, or canceled and past its cycle.
 */
export type OrganizationPlan = {
  planId: string
  planName: string
  /**
   * The effective state, not the stored one: a subscription canceled
   * mid-cycle still reports `active` (with `cancelAtPeriodEnd`) until the
   * quota it already paid for runs out.
   */
  status: 'active' | 'past_due' | 'canceled'
  cycleFrom: Date
  cycleTo: Date
  includedQuotaCents: number | null
  quotaConsumedCents: number
  quotaRemainingCents: number | null
  /** Set when a downgrade is queued for the next cycle roll. */
  pendingPlanId?: string
  /** Set while a cancel is scheduled and the paid cycle is still running. */
  cancelAtPeriodEnd?: true
  /** Present only while `status` is `past_due`. */
  dueAt?: Date
  amountDueCents?: number
  phase?: 'grace' | 'hold'
  /** What the open charge means for access, independent of `planId`. */
  entitlements?: 'active' | 'suspended'
  requiredAction?: 'retrying' | 'needs_card' | 'needs_authentication'
}
