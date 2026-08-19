/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * The organization's plan and its cycle quota. The wire body of
 * `GET organization/:id/plan` is `{ plan?: OrganizationPlan }` — an empty
 * object when there is no live plan, never a bare null or this shape
 * unwrapped (boxlite-commerce billing.controller.ts, getOrganizationPlan).
 * `getOrganizationPlan()` in billingApiClient.ts does that unwrapping, so
 * every other consumer sees this type directly, or `null` for "no plan".
 * `includedQuotaCents`/`quotaRemainingCents` of null mean unlimited (a
 * negotiated deal), not zero.
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
