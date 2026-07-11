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

export interface PaymentReconcileInput {
  operation: 'setup' | 'top_up'
  providerReference: string
}

export type PaymentReconcileResult = { status: 'pending' } | { status: 'resolved'; event: ProviderWebhookEvent }

export type ProviderWebhookEvent =
  | {
      kind: 'setup_succeeded'
      providerEventId: string
      providerReference: string
      organizationId: string
      setupAttemptId: string
      providerCustomerId: string
      paymentMethod: PaymentMethodView
    }
  | {
      kind: 'setup_failed'
      providerEventId: string
      providerReference: string
      organizationId: string
      setupAttemptId: string
      failureCode: string
      failureMessage: string
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
  | {
      kind: 'top_up_adjusted'
      providerEventId: string
      providerReference: string
      topUpId: string
      organizationId: string
      amountCents: string
      currency: string
      adjustment: 'refund' | 'dispute'
      direction: 'debit' | 'restore'
    }

export interface PaymentProvider {
  readonly mode: 'fake' | 'stripe'
  createSetup(input: PaymentSetupInput): Promise<PaymentSetupResult>
  createManualTopUp(input: TopUpPaymentInput): Promise<TopUpPaymentResult>
  chargeSavedMethod(input: TopUpPaymentInput): Promise<TopUpPaymentResult>
  reconcile(input: PaymentReconcileInput): Promise<PaymentReconcileResult>
  parseWebhook(payload: Buffer, signature: string): Promise<ProviderWebhookEvent | null>
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER')
