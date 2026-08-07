/*
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { describe, expect, it } from 'vitest'
import type { OrganizationTier, Tier } from '@/billing-api'
import {
  canUpgradeTo,
  getTierRequirements,
  getUpgradeRequirements,
  type TierRequirementsState,
} from './tierRequirements'

const DAY_MS = 24 * 60 * 60 * 1000

function tier(partial: Partial<Tier> & Pick<Tier, 'tier'>): Tier {
  return {
    tierLimit: { concurrentCPU: 10, concurrentRAMGiB: 20, concurrentDiskGiB: 30 },
    minTopUpAmountCents: 0,
    topUpIntervalDays: 0,
    ...partial,
  }
}

function orgTier(partial: Partial<OrganizationTier> & Pick<OrganizationTier, 'tier'>): OrganizationTier {
  return {
    largestSuccessfulPaymentCents: 0,
    hasVerifiedBusinessEmail: false,
    ...partial,
  }
}

const met: TierRequirementsState = { emailVerified: true, creditCardLinked: true }
const unmet: TierRequirementsState = { emailVerified: false, creditCardLinked: false }

describe('getTierRequirements', () => {
  it('returns nothing when the organization has no tier yet', () => {
    expect(getTierRequirements(met, null, tier({ tier: 1 }))).toEqual([])
  })

  it('returns nothing for an unknown target tier', () => {
    expect(getTierRequirements(met, orgTier({ tier: 1 }), tier({ tier: 9 }))).toEqual([])
  })

  it('requires email verification for tier 1', () => {
    const items = getTierRequirements(unmet, orgTier({ tier: 0 }), tier({ tier: 1 }))
    expect(items).toEqual([{ label: 'Email verification', isChecked: false }])
  })

  it('requires a linked card for tier 2', () => {
    const [card] = getTierRequirements(unmet, orgTier({ tier: 1 }), tier({ tier: 2 }))
    expect(card.label).toBe('Credit card linked')
    expect(card.isChecked).toBe(false)
  })

  it('reflects satisfied state from requirementsState', () => {
    const [card] = getTierRequirements(met, orgTier({ tier: 1 }), tier({ tier: 2 }))
    expect(card.isChecked).toBe(true)
  })

  it('adds a top-up requirement, unmet when the largest payment is too small', () => {
    const items = getTierRequirements(
      met,
      orgTier({ tier: 2, largestSuccessfulPaymentCents: 4_999 }),
      tier({ tier: 3, minTopUpAmountCents: 50_000 }),
    )
    const topUp = items.find((item) => item.label.startsWith('Top up'))
    expect(topUp?.label).toBe('Top up $500 (one time)')
    expect(topUp?.isChecked).toBe(false)
  })

  it('marks the top-up met once a large enough payment exists', () => {
    const items = getTierRequirements(
      met,
      orgTier({ tier: 2, largestSuccessfulPaymentCents: 50_000 }),
      tier({ tier: 3, minTopUpAmountCents: 50_000 }),
    )
    expect(items.find((item) => item.label.startsWith('Top up'))?.isChecked).toBe(true)
  })

  it('treats a recurring top-up as unmet once the interval has lapsed', () => {
    const items = getTierRequirements(
      met,
      orgTier({
        tier: 3,
        largestSuccessfulPaymentCents: 200_000,
        largestSuccessfulPaymentDate: new Date(Date.now() - 40 * DAY_MS),
      }),
      tier({ tier: 4, minTopUpAmountCents: 200_000, topUpIntervalDays: 30 }),
    )
    const topUp = items.find((item) => item.label.startsWith('Top up'))
    expect(topUp?.label).toBe('Top up $2,000 (every 30 days)')
    expect(topUp?.isChecked).toBe(false)
  })

  it('treats a recurring top-up as met inside the interval', () => {
    const items = getTierRequirements(
      met,
      orgTier({
        tier: 3,
        largestSuccessfulPaymentCents: 200_000,
        largestSuccessfulPaymentDate: new Date(Date.now() - 5 * DAY_MS),
      }),
      tier({ tier: 4, minTopUpAmountCents: 200_000, topUpIntervalDays: 30 }),
    )
    expect(items.find((item) => item.label.startsWith('Top up'))?.isChecked).toBe(true)
  })
})

describe('canUpgradeTo', () => {
  it('blocks when there are no requirements at all — the no-tier case', () => {
    expect(canUpgradeTo([])).toBe(false)
    expect(canUpgradeTo(getTierRequirements(met, null, tier({ tier: 1 })))).toBe(false)
  })

  it('blocks while any requirement is unmet', () => {
    expect(canUpgradeTo(getTierRequirements(unmet, orgTier({ tier: 1 }), tier({ tier: 2 })))).toBe(false)
  })

  it('allows once every requirement is met', () => {
    const items = getTierRequirements(
      met,
      orgTier({ tier: 1, largestSuccessfulPaymentCents: 50_000 }),
      tier({ tier: 2, minTopUpAmountCents: 50_000 }),
    )
    expect(items.every((item) => item.isChecked)).toBe(true)
    expect(canUpgradeTo(items)).toBe(true)
  })
})

describe('getUpgradeRequirements', () => {
  const catalogue = [
    tier({ tier: 1 }),
    tier({ tier: 2, minTopUpAmountCents: 2_500 }),
    tier({ tier: 3, minTopUpAmountCents: 50_000 }),
    tier({ tier: 4, minTopUpAmountCents: 200_000 }),
  ]

  it('collects the skipped tiers, not just the target', () => {
    // Tier 1 -> tier 3 skips tier 2, whose requirement is the linked card.
    const labels = getUpgradeRequirements(
      { emailVerified: true, creditCardLinked: false },
      orgTier({ tier: 1, largestSuccessfulPaymentCents: 50_000 }),
      catalogue[2],
      catalogue,
    ).map((item) => item.label)

    expect(labels).toContain('Credit card linked')
  })

  it('blocks that jump while the skipped requirement is unmet', () => {
    const items = getUpgradeRequirements(
      { emailVerified: true, creditCardLinked: false },
      orgTier({ tier: 1, largestSuccessfulPaymentCents: 50_000 }),
      catalogue[2],
      catalogue,
    )
    expect(canUpgradeTo(items)).toBe(false)
  })

  it('allows the jump once the skipped requirement is met', () => {
    const items = getUpgradeRequirements(
      met,
      orgTier({ tier: 1, largestSuccessfulPaymentCents: 50_000 }),
      catalogue[2],
      catalogue,
    )
    expect(canUpgradeTo(items)).toBe(true)
  })

  it('does not duplicate a requirement shared by two skipped tiers', () => {
    // Tiers 3 and 4 ask for the same top-up, so both steps emit an identical label.
    const shared = [
      tier({ tier: 1 }),
      tier({ tier: 2 }),
      tier({ tier: 3, minTopUpAmountCents: 50_000 }),
      tier({ tier: 4, minTopUpAmountCents: 50_000 }),
    ]
    const labels = getUpgradeRequirements(met, orgTier({ tier: 2 }), shared[3], shared).map((item) => item.label)

    expect(labels).toEqual(['Top up $500 (one time)'])
  })

  it('ignores tiers at or below the current one', () => {
    const labels = getUpgradeRequirements(
      met,
      orgTier({ tier: 2, largestSuccessfulPaymentCents: 200_000 }),
      catalogue[3],
      catalogue,
    ).map((item) => item.label)
    expect(labels).not.toContain('Email verification')
    expect(labels).not.toContain('Credit card linked')
  })
})
