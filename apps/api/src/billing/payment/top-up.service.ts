/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Inject, Injectable } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource } from 'typeorm'
import { TopUpRecord } from '../entities/top-up-record.entity'
import { PAYMENT_PROVIDER, PaymentProvider } from './payment-provider.interface'

const DASHBOARD_URL = process.env.DASHBOARD_URL ?? 'https://app.boxlite.ai'

/**
 * Starts a manual top-up: the two-stage flow Stripe requires. We record a
 * `pending` top_up_record (the wallet balance does NOT move yet), ask the
 * provider for a checkout intent, and hand back the redirect URL. The wallet is
 * credited later, once, by WebhookService when the provider confirms payment.
 */
@Injectable()
export class TopUpService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  async createCheckout(organizationId: string, amountCents: number): Promise<{ url: string }> {
    if (amountCents <= 0) throw new Error(`top-up amount must be positive, got ${amountCents}`)
    const records = this.dataSource.getRepository(TopUpRecord)

    const record = await records.save(
      records.create({ organizationId, amountCents: String(amountCents), method: 'manual', status: 'pending' }),
    )

    const intent = await this.provider.createTopUpIntent({
      organizationId,
      amountCents,
      idempotencyKey: record.id, // derive idempotency from the pending row
      successUrl: `${DASHBOARD_URL}/billing?topup=success`,
      cancelUrl: `${DASHBOARD_URL}/billing?topup=cancel`,
    })

    await records.update(record.id, { stripeSessionId: intent.providerRef })
    return { url: intent.redirectUrl }
  }
}
