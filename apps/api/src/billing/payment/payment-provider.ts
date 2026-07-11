/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export interface PaymentMethodView {
  id: string
  brand: string
  last4: string
}

export interface PaymentSetupInput {
  organizationId: string
  walletId: string
  setupAttemptId: string
  providerCustomerId: string | null
  successUrl: string
  cancelUrl: string
}

export interface PaymentSetupResult {
  status: 'ready' | 'pending'
  checkoutUrl: string | null
  providerReference: string
  providerCustomerId: string
  paymentMethod: PaymentMethodView | null
}

export interface TopUpPaymentInput {
  organizationId: string
  topUpId: string
  amountCents: string
  providerCustomerId: string
  providerMethodId: string
  successUrl: string
  cancelUrl: string
}

export interface TopUpPaymentResult {
  status: 'pending' | 'paid' | 'failed'
  checkoutUrl: string | null
  providerReference: string
  receiptUrl: string | null
  failureCode?: string
  failureMessage?: string
}

export type ProviderWebhookEvent =
  | {
      kind: 'setup_succeeded'
      providerEventId: string
      providerReference: string
      organizationId: string
      providerCustomerId: string
      paymentMethod: PaymentMethodView
    }
  | {
      kind: 'top_up_paid'
      providerEventId: string
      providerReference: string
      topUpId: string
      organizationId: string
      amountCents: string
      currency: string
      receiptUrl: string | null
    }
  | {
      kind: 'top_up_failed'
      providerEventId: string
      providerReference: string
      topUpId: string
      organizationId: string
      failureCode: string | null
      failureMessage: string | null
    }

export interface PaymentProvider {
  readonly mode: 'fake' | 'stripe'
  createSetup(input: PaymentSetupInput): Promise<PaymentSetupResult>
  createManualTopUp(input: TopUpPaymentInput): Promise<TopUpPaymentResult>
  chargeSavedMethod(input: TopUpPaymentInput): Promise<TopUpPaymentResult>
  parseWebhook(payload: Buffer, signature: string): Promise<ProviderWebhookEvent | null>
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER')
