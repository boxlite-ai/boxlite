/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common'
import { ApiExcludeEndpoint } from '@nestjs/swagger'
import { WebhookService, WebhookOutcome } from './payment/webhook.service'

/**
 * Public payment-provider webhook sink — NO auth guard; trust comes from the
 * provider signature, which WebhookService verifies. Settlement is idempotent
 * (processed_stripe_event PK), so the provider can safely retry.
 *
 * TODO(stripe): the real Stripe integration needs the RAW request body for
 * signature verification — enable `rawBody` on the Nest app and read it here
 * instead of the parsed JSON. With FakePaymentProvider the JSON body IS the
 * normalized event, which is enough to exercise the settlement path in tests.
 */
@Controller('billing/webhook')
export class BillingWebhookController {
  constructor(private readonly webhooks: WebhookService) {}

  @Post()
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async ingest(
    @Body() body: unknown,
    @Headers('stripe-signature') signature = '',
  ): Promise<{ outcome: WebhookOutcome }> {
    const raw = Buffer.from(JSON.stringify(body ?? {}))
    return { outcome: await this.webhooks.ingest(raw, signature) }
  }
}
