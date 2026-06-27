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
 * In-memory payment provider for tests + local dev. No network, no signature
 * check: `createTopUpIntent` hands back a fake checkout url, and `parseWebhook`
 * just JSON-parses a hand-built event so tests can drive the settlement path
 * (top-up confirmed / refund / saved method) directly. The real StripeProvider
 * implements the same interface; nothing in WalletService changes.
 */
@Injectable()
export class FakePaymentProvider implements PaymentProvider {
  async createTopUpIntent(input: CreateTopUpIntentInput): Promise<TopUpIntentResult> {
    const ref = `fake_cs_${input.idempotencyKey}`
    return { redirectUrl: `https://fake-checkout.local/${ref}`, providerRef: ref, status: 'processing' }
  }

  async chargeSavedMethod(input: ChargeSavedMethodInput): Promise<ChargeResult> {
    return { providerRef: `fake_pi_${input.idempotencyKey}`, status: 'succeeded' }
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    return { providerRef: `fake_re_${input.idempotencyKey}`, status: 'succeeded' }
  }

  async setupSaveMethod(input: SaveMethodSetupInput): Promise<SaveMethodSetupResult> {
    const ref = `fake_seti_${input.organizationId}`
    return { redirectUrl: `https://fake-setup.local/${ref}`, providerRef: ref }
  }

  /** No signature verification — the raw body IS the normalized event (test driver). */
  parseWebhook(rawBody: Buffer, _signature: string): VerifiedWebhookEvent {
    return JSON.parse(rawBody.toString('utf8')) as VerifiedWebhookEvent
  }
}
