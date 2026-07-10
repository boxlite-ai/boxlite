/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export interface BillingUsageSummary {
  costPreciseCents: string
  costCents: string
  cpuSeconds: string
  memGibSeconds: string
  diskGibSeconds: string
  gpuSeconds: string
  periodCount: number
}

export interface BillingUsageBucket extends BillingUsageSummary {
  from: string
  to: string
}

export interface BillingPricing {
  version: number
  effectiveFrom: string
  cpuRateCentsPerHour: string
  memRateCentsPerHour: string
  diskRateCentsPerHour: string
  gpuRateCentsPerHour: string
}

export interface BillingOverview {
  wallet: {
    freeBalanceCents: string
    paidBalanceCents: string
    totalBalanceCents: string
    billingStatus: 'trial' | 'active' | 'zero_balance'
    freeExpiresAt: string | null
  }
  spentThisMonthCents: string
  usage: BillingUsageSummary
  usageBuckets: BillingUsageBucket[]
  pricing: BillingPricing
}
