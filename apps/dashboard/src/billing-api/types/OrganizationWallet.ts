/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export interface OrganizationWallet {
  balanceCents: number
  ongoingBalanceCents: number
  name: string
  creditCardConnected: boolean

  automaticTopUp?: AutomaticTopUp
  creditGrantedCents?: number
  creditRemainingCents?: number
  /**
   * The organization's top-up discount as 4-decimal text in (0, 1]:
   * `'1.0000'` is none, and below it top-ups are discounted by (1 − m), so
   * `'0.7000'` is 30% off. That holds only for a billing API that prices
   * top-ups at this multiplier. Absent reads as no discount.
   */
  usageChargeMultiplier?: string
}

export type AutomaticTopUp = {
  thresholdAmount: number
  targetAmount: number
}

export interface WalletTopUpRequest {
  amountCents: number
}

export interface PaymentUrl {
  url: string
}

/**
 * Whether the organization's signup credit is in its wallet. Once true it
 * stays true. False covers a credit still on its way and one that never comes:
 * the credit switched off, or an organization that is not granted one.
 */
export interface SignupCreditDelivery {
  delivered: boolean
}
