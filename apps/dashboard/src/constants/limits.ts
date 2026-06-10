/**
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export const TIER_REQUIREMENTS: Record<number, string[]> = {
  1: ['Email verification'],
  2: ['Credit card linked', 'GitHub connected', 'Top up $25 (one time)'],
  3: ['Business email verified', 'Top up $500 (one time)'],
  4: ['Top up $2,000 (every 30 days)'],
}

export const TIER_RATE_LIMITS: Record<
  number,
  { authenticatedRateLimit: number; boxCreateRateLimit: number; boxLifecycleRateLimit: number }
> = {
  1: {
    authenticatedRateLimit: 10_000,
    boxCreateRateLimit: 300,
    boxLifecycleRateLimit: 10_000,
  },
  2: {
    authenticatedRateLimit: 20_000,
    boxCreateRateLimit: 400,
    boxLifecycleRateLimit: 20_000,
  },
  3: {
    authenticatedRateLimit: 40_000,
    boxCreateRateLimit: 500,
    boxLifecycleRateLimit: 40_000,
  },
  4: {
    authenticatedRateLimit: 50_000,
    boxCreateRateLimit: 600,
    boxLifecycleRateLimit: 50_000,
  },
}
