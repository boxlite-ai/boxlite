/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export type Tier = {
  tier: number
  tierLimit: TierLimit
  minTopUpAmountCents: number
  topUpIntervalDays: number
  /**
   * The plan riding this rung, when one does. The billing service composes
   * these onto the catalog from its own constant, so a rung without a plan
   * simply omits them rather than carrying zeros.
   *
   * `concurrencyLimit` is the plan's ceiling on simultaneously running boxes.
   * It is DISPLAY ONLY: nothing enforces it yet, so a count at or above it
   * means the customer has reached what they bought, not that the next box
   * was refused. `null` is a negotiated deal with no stated ceiling.
   */
  planId?: string
  planName?: string
  priceMonthlyCents?: number | null
  includedQuotaCents?: number | null
  concurrencyLimit?: number | null
  selfServe?: boolean
}

export type TierLimit = {
  concurrentCPU: number
  concurrentRAMGiB: number
  concurrentDiskGiB: number
}
