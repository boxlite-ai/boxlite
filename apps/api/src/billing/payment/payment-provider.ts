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
  operation: 'setup' | 'top_up' | 'subscription'
  providerReference: string
}

export type PaymentReconcileResult = { status: 'pending' } | { status: 'resolved'; event: ProviderWebhookEvent }

export interface SubscriptionCheckoutInput {
  organizationId: string
  idempotencyKey: string
  planCode: string
  providerPriceId: string
  providerCustomerId: string | null
  successUrl: string
  cancelUrl: string
}

export interface SubscriptionCheckoutResult {
  checkoutUrl: string
  providerReference: string
  snapshot: ProviderSubscriptionSnapshot | null
}

export interface SubscriptionChangeInput {
  organizationId: string
  idempotencyKey: string
  providerSubscriptionId: string
  providerScheduleId: string | null
  providerPriceId: string
  planCode: string
}

export interface ProviderSubscriptionSnapshot {
  organizationId: string
  providerSubscriptionId: string
  providerCustomerId: string
  providerPriceId: string
  providerScheduleId: string | null
  status: 'pending' | 'active' | 'past_due' | 'canceled'
  currentPeriodStart: string
  currentPeriodEnd: string
}

export interface SubscriptionChangeResult {
  snapshot: ProviderSubscriptionSnapshot
  providerScheduleId: string | null
}

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
  | {
      kind: 'subscription_checkout_expired'
      providerEventId: string
      providerReference: string
      organizationId: string
    }
  | {
      kind: 'subscription_synced'
      providerEventId: string
      providerReference: string
      snapshot: ProviderSubscriptionSnapshot
    }
  | {
      kind: 'subscription_period_paid'
      providerEventId: string
      providerReference: string
      snapshot: ProviderSubscriptionSnapshot
    }

export interface PaymentProvider {
  readonly mode: 'fake' | 'stripe'
  createSetup(input: PaymentSetupInput): Promise<PaymentSetupResult>
  createManualTopUp(input: TopUpPaymentInput): Promise<TopUpPaymentResult>
  chargeSavedMethod(input: TopUpPaymentInput): Promise<TopUpPaymentResult>
  reconcile(input: PaymentReconcileInput): Promise<PaymentReconcileResult>
  createSubscriptionCheckout(input: SubscriptionCheckoutInput): Promise<SubscriptionCheckoutResult>
  upgradeSubscription(input: SubscriptionChangeInput): Promise<SubscriptionChangeResult>
  scheduleSubscriptionDowngrade(input: SubscriptionChangeInput): Promise<SubscriptionChangeResult>
  parseWebhook(payload: Buffer, signature: string): Promise<ProviderWebhookEvent | null>
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER')
