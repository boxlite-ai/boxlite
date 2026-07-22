/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

// Subscription plan data + wallet model (no burst).
// Exceeding concurrency = hard reject (429) for ALL tiers.
// Overage beyond quota draws from wallet balance at PAYG rates.

export type SubscriptionPlan = {
  id: string
  tier: number
  name: string
  priceMonthly: number | null
  quotaUsd: number | null
  quotaLeverage: string | null
  concurrencyLimit: number | 'unlimited'
  audience: string
  custom?: boolean
}

export const PLANS: SubscriptionPlan[] = [
  {
    id: 'starter',
    tier: 1,
    name: 'Starter',
    priceMonthly: 19,
    quotaUsd: 30,
    quotaLeverage: '1.57×',
    concurrencyLimit: 20,
    audience: 'Independent devs & side projects',
  },
  {
    id: 'pro',
    tier: 2,
    name: 'Pro',
    priceMonthly: 149,
    quotaUsd: 250,
    quotaLeverage: '1.67×',
    concurrencyLimit: 100,
    audience: 'AI builders with early traffic',
  },
  {
    id: 'max',
    tier: 3,
    name: 'Max',
    priceMonthly: 499,
    quotaUsd: 900,
    quotaLeverage: '1.8×',
    concurrencyLimit: 1000,
    audience: 'High-frequency production agents',
  },
  {
    id: 'enterprise',
    tier: 4,
    name: 'Enterprise',
    priceMonthly: null,
    quotaUsd: null,
    quotaLeverage: null,
    concurrencyLimit: 'unlimited',
    audience: 'Large orgs with compliance needs',
    custom: true,
  },
]

export const CURRENT_TIER = 2

// ─── Demo utilization ────────────────────────────────────────────────────────

export const DEMO_QUOTA_USED = 163.2
export const DEMO_CONCURRENT = 61

// ─── Wallet (PRD: overage draws from balance) ────────────────────────────────

export const WALLET_BALANCE = 87.6
export const WALLET_USED_THIS_MONTH = 112.4
export const WALLET_TOTAL = WALLET_BALANCE + WALLET_USED_THIS_MONTH // 200
export const WALLET_AUTO_RELOAD = { enabled: true, threshold: 20, amount: 100 }

// ─── User state ──────────────────────────────────────────────────────────────

export type UserBillingState =
  | 'active'
  | 'balance_low'
  | 'suspended'
  | 'free_trial'
  | 'credit_exhausted'

export const DEMO_USER_STATE: UserBillingState = 'active'

// Free trial = initial wallet balance with no subscription
export const FREE_CREDIT_TOTAL = 100
export const FREE_CREDIT_USED = 37.7
export const FREE_CREDIT_REMAINING = FREE_CREDIT_TOTAL - FREE_CREDIT_USED

// Suspension countdown (PRD §4.3)
export const DESTRUCTION_COUNTDOWN_DAYS = 5
