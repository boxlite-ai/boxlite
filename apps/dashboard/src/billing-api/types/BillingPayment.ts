/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export interface BillingPaymentMethod {
  brand: string
  last4: string
}

export interface BillingAutoReload {
  enabled: boolean
  thresholdCents: string | null
  targetCents: string | null
}

export interface BillingPayment {
  providerMode: 'fake' | 'stripe'
  paymentMethod: BillingPaymentMethod | null
  autoReload: BillingAutoReload
}

export interface BillingPaymentSetupResult {
  status: 'ready' | 'pending'
  checkoutUrl: string | null
}

export interface BillingTopUpResult {
  id: string
  status: 'pending' | 'paid' | 'failed'
  checkoutUrl: string | null
}

export interface BillingReceipt {
  id: string
  createdAt: string
  amountCents: string
  type: 'top_up' | 'usage'
  status: 'paid' | 'failed'
  receiptUrl: string | null
}

export interface BillingReceiptsPage {
  items: BillingReceipt[]
  page: number
  pageSize: number
  total: number
}

export interface BillingReceiptsQuery {
  page: number
  pageSize: number
  query: string
}
