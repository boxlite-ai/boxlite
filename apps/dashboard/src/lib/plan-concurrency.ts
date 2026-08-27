/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { OrganizationPlan, Plan } from '@/billing-api'

/**
 * A custom deal has no public catalog row, so its ceiling is unknown here.
 * `null` means no displayable ceiling; it never means zero concurrent boxes.
 */
export function planConcurrencyLimit(
  organizationPlan: OrganizationPlan | null | undefined,
  catalog: Plan[] | undefined,
): number | null {
  if (!organizationPlan) return null
  return catalog?.find((plan) => plan.id === organizationPlan.planId)?.concurrencyLimit ?? null
}
