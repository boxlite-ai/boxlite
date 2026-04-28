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
}

export type TierLimit = {
  concurrentCPU: number
  concurrentRAMGiB: number
  concurrentDiskGiB: number
}
