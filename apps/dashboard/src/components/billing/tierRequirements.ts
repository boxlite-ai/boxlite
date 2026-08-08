/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationTier, Tier } from '@/billing-api'
import { formatWholeDollars } from '@/lib/utils'

/**
 * Preconditions the server enforces before an organization may move up a tier.
 * The plan cards gate their Upgrade action on these rather than letting the
 * request fail; an empty list means "not upgradable", not "no conditions".
 */

export interface TierRequirementsState {
  emailVerified: boolean
  creditCardLinked: boolean
}

export interface TierRequirement {
  label: string
  isChecked: boolean
}

function hasSatisfiedTopUp(currentTier: OrganizationTier, nextTier: Tier): boolean {
  if (currentTier.largestSuccessfulPaymentCents < nextTier.minTopUpAmountCents) {
    return false
  }

  // A recurring requirement lapses: the qualifying payment must fall inside the interval.
  if (nextTier.topUpIntervalDays && currentTier.largestSuccessfulPaymentDate) {
    const elapsedDays = Math.ceil(
      Math.abs(Date.now() - currentTier.largestSuccessfulPaymentDate.getTime()) / (1000 * 60 * 60 * 24),
    )
    return elapsedDays < nextTier.topUpIntervalDays
  }

  return true
}

export function getTierRequirements(
  requirementsState: TierRequirementsState,
  currentTier?: OrganizationTier | null,
  tier?: Tier | null,
): TierRequirement[] {
  if (!tier || !currentTier) {
    return []
  }
  if (tier.tier < 1 || tier.tier > 4) {
    return []
  }

  const items: TierRequirement[] = []

  if (tier.tier === 1) {
    items.push({
      label: 'Email verification',
      isChecked: requirementsState.emailVerified,
    })
  }
  if (tier.tier === 2) {
    items.push({
      label: 'Credit card linked',
      isChecked: requirementsState.creditCardLinked,
    })
  }

  if (tier.minTopUpAmountCents) {
    items.push({
      label: `Top up ${formatWholeDollars(tier.minTopUpAmountCents)} (${tier.topUpIntervalDays ? `every ${tier.topUpIntervalDays} days` : 'one time'})`,
      isChecked: hasSatisfiedTopUp(currentTier, tier),
    })
  }

  return items
}

/**
 * Requirements for jumping straight from the current tier to `target`.
 *
 * Each tier attaches its own preconditions (email at 1, a linked card at 2, a
 * top-up wherever `minTopUpAmountCents` is set), so a multi-step jump must
 * collect every tier it skips — asking only for the target's own conditions
 * would let a tier-1 org reach tier 3 without ever linking a card.
 */
export function getUpgradeRequirements(
  requirementsState: TierRequirementsState,
  currentTier: OrganizationTier | null | undefined,
  target: Tier,
  tiers: Tier[],
): TierRequirement[] {
  const from = currentTier?.tier ?? 0
  const steps = tiers.filter((tier) => tier.tier > from && tier.tier <= target.tier)
  const collected = steps.flatMap((step) => getTierRequirements(requirementsState, currentTier, step))

  const seen = new Set<string>()
  return collected.filter((item) => {
    if (seen.has(item.label)) {
      return false
    }
    seen.add(item.label)
    return true
  })
}

/** An upgrade is allowed only once every listed requirement is met. */
export function canUpgradeTo(requirements: TierRequirement[]): boolean {
  return requirements.length > 0 && requirements.every((requirement) => requirement.isChecked)
}
