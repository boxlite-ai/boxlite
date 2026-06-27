/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Inject, Injectable, Logger } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource, EntityManager, QueryFailedError } from 'typeorm'
import { ProcessedStripeEvent } from '../entities/processed-stripe-event.entity'
import { Wallet } from '../entities/wallet.entity'
import { WalletService } from '../wallet/wallet.service'
import { PAYMENT_PROVIDER, PaymentProvider, VerifiedWebhookEvent } from './payment-provider.interface'

const PG_UNIQUE_VIOLATION = '23505'

function isUniqueViolation(err: unknown): boolean {
  return err instanceof QueryFailedError && (err.driverError as { code?: string })?.code === PG_UNIQUE_VIOLATION
}

export type WebhookOutcome = 'processed' | 'duplicate' | 'ignored'

/**
 * Ingests payment-provider webhooks and settles their effect on the wallet.
 * Idempotency is structural: the provider event id is inserted into
 * `processed_stripe_event` IN THE SAME TRANSACTION as the balance change, so a
 * re-delivered webhook hits the unique PK, the whole transaction rolls back, and
 * the wallet is never credited twice (Stripe's official "log event ids" guidance).
 * The settlement ledger row also carries `providerEventId` (partial-unique) as a
 * second guard.
 */
@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name)

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly wallet: WalletService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  /** Verify + parse a raw webhook, then apply it exactly once. */
  async ingest(rawBody: Buffer, signature: string): Promise<WebhookOutcome> {
    const event = this.provider.parseWebhook(rawBody, signature)
    if (event.type === 'ignored') return 'ignored'

    try {
      await this.dataSource.transaction(async (manager) => {
        await manager.insert(ProcessedStripeEvent, { stripeEventId: event.eventId, eventType: event.type })
        await this.apply(manager, event)
      })
      return 'processed'
    } catch (err) {
      if (isUniqueViolation(err)) {
        this.logger.log(`duplicate webhook ${event.eventId} (${event.type}) ignored`)
        return 'duplicate'
      }
      throw err
    }
  }

  private async apply(manager: EntityManager, event: VerifiedWebhookEvent): Promise<void> {
    switch (event.type) {
      case 'topup.succeeded': {
        if (!event.organizationId || event.amountCents == null) {
          throw new Error(`topup webhook ${event.eventId} missing organizationId/amountCents`)
        }
        await this.wallet.topUpWithin(manager, event.organizationId, event.amountCents, 'manual', event.eventId)
        return
      }
      case 'method.saved': {
        if (event.organizationId) {
          await manager.update(Wallet, { organizationId: event.organizationId }, { creditCardConnected: true })
        }
        return
      }
      case 'topup.failed':
        // No money moved; the pending top_up_record is marked failed elsewhere. Auto-reload
        // failure degrades the wallet back to low_balance, never to debt.
        this.logger.warn(`top-up failed webhook ${event.eventId}`)
        return
      case 'refund.succeeded':
        // TODO(stripe, M2): reverse the wallet (debit the paid pool by the refunded
        // amount). Deferred — refund/chargeback policy (PRD Q15) is still open.
        this.logger.warn(`refund webhook ${event.eventId} received; wallet reversal not wired yet`)
        return
    }
  }
}
