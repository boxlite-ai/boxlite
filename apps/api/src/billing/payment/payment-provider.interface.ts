/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * The payment-provider seam. The provider only understands *money movement*
 * (checkout, charge a saved card, refund, verify a webhook); all dual-pool
 * wallet logic lives in WalletService. This lets us run the whole billing loop
 * tonight against a FakeProvider and drop in a real StripeProvider later without
 * touching wallet code.
 */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER')

export interface CreateTopUpIntentInput {
  organizationId: string
  amountCents: number
  /** Our idempotency key, derived from the top_up_record id. */
  idempotencyKey: string
  successUrl: string
  cancelUrl: string
}

export interface TopUpIntentResult {
  /** Where to send the user to pay (Stripe Checkout url). */
  redirectUrl: string
  /** Provider-side handle (Checkout Session id) for later reconciliation. */
  providerRef: string
  status: 'processing'
}

export interface ChargeSavedMethodInput {
  organizationId: string
  amountCents: number
  idempotencyKey: string
}

export interface ChargeResult {
  providerRef: string
  status: 'succeeded' | 'failed'
}

export interface RefundInput {
  providerRef: string
  amountCents: number
  idempotencyKey: string
}

export interface RefundResult {
  providerRef: string
  status: 'succeeded' | 'failed'
}

export interface SaveMethodSetupInput {
  organizationId: string
  successUrl: string
  cancelUrl: string
}

export interface SaveMethodSetupResult {
  redirectUrl: string
  providerRef: string
}

/** A provider webhook, normalized to a provider-neutral shape. */
export interface VerifiedWebhookEvent {
  /** Provider event id — used for idempotent ingest (processed_stripe_event). */
  eventId: string
  type: 'topup.succeeded' | 'topup.failed' | 'refund.succeeded' | 'method.saved' | 'ignored'
  organizationId: string | null
  amountCents: number | null
  providerRef: string | null
}

export interface PaymentProvider {
  /** Manual top-up — Stripe Checkout Session (mode=payment). */
  createTopUpIntent(input: CreateTopUpIntentInput): Promise<TopUpIntentResult>
  /** Auto-reload — off-session PaymentIntent against a saved method. */
  chargeSavedMethod(input: ChargeSavedMethodInput): Promise<ChargeResult>
  refund(input: RefundInput): Promise<RefundResult>
  /** Store a reusable off-session method — Stripe SetupIntent. */
  setupSaveMethod(input: SaveMethodSetupInput): Promise<SaveMethodSetupResult>
  /** Verify signature + parse a raw webhook body into a neutral event. */
  parseWebhook(rawBody: Buffer, signature: string): VerifiedWebhookEvent
}
