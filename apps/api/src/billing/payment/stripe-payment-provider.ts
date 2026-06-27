/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import {
  ChargeResult,
  ChargeSavedMethodInput,
  CreateTopUpIntentInput,
  PaymentProvider,
  RefundInput,
  RefundResult,
  SaveMethodSetupInput,
  SaveMethodSetupResult,
  TopUpIntentResult,
  VerifiedWebhookEvent,
} from './payment-provider.interface'

/**
 * Real Stripe provider — STUB. Phase 2 ships the seam, not the live integration
 * (no `stripe` SDK dependency, no keys tonight). Each method documents exactly
 * what the implementation must do so wiring it up later is mechanical.
 *
 * TODO(stripe), when wiring up:
 *  - createTopUpIntent → Checkout Session, `mode: 'payment'`, pass our
 *    `idempotencyKey` as the Stripe idempotency key; return session.url.
 *  - chargeSavedMethod → PaymentIntent `off_session: true, confirm: true` against
 *    the saved payment method; map card errors to status: 'failed'.
 *  - setupSaveMethod → SetupIntent / Checkout `mode: 'setup'`.
 *  - refund → refunds.create; idempotencyKey from the refund row.
 *  - parseWebhook → stripe.webhooks.constructEvent(RAW body, sig, endpointSecret).
 *    MUST use the raw request body (not the parsed JSON), a restricted `rk_` key,
 *    and the default signature tolerance. Map checkout.session.completed →
 *    'topup.succeeded', charge.refunded → 'refund.succeeded', etc.; everything
 *    else → 'ignored'. The returned eventId is `event.id` (webhook idempotency).
 */
@Injectable()
export class StripePaymentProvider implements PaymentProvider {
  private notWired(method: string): never {
    throw new Error(`StripePaymentProvider.${method} is not wired up yet (Phase 2 ships the seam only)`)
  }

  createTopUpIntent(_input: CreateTopUpIntentInput): Promise<TopUpIntentResult> {
    return this.notWired('createTopUpIntent')
  }

  chargeSavedMethod(_input: ChargeSavedMethodInput): Promise<ChargeResult> {
    return this.notWired('chargeSavedMethod')
  }

  refund(_input: RefundInput): Promise<RefundResult> {
    return this.notWired('refund')
  }

  setupSaveMethod(_input: SaveMethodSetupInput): Promise<SaveMethodSetupResult> {
    return this.notWired('setupSaveMethod')
  }

  parseWebhook(_rawBody: Buffer, _signature: string): VerifiedWebhookEvent {
    return this.notWired('parseWebhook')
  }
}
