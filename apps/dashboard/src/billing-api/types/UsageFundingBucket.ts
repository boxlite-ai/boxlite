/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * One bucket of the funding-split series: settlement money grouped by when it
 * moved, split between the plan's quota and the wallet. Buckets are
 * dense — a quiet day arrives as an honest zero, not a gap.
 */
export type UsageFundingBucket = {
  from: Date
  to: Date
  quotaCoveredCents: number
  fromWalletCents: number
}

export type SeriesGranularity = 'day' | 'hour'
