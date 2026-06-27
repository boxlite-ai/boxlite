/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Inject, Injectable, Logger } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource, EntityManager, QueryFailedError } from 'typeorm'
import { ProcessedStripeEvent } from '../entities/processed-stripe-event.entity'
import { TopUpRecord, TopUpStatus } from '../entities/top-up-record.entity'
import { Wallet } from '../entities/wallet.entity'
import { WalletTransaction } from '../entities/wallet-transaction.entity'
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
        await this.settleTopUpRecord(manager, event, 'paid')
        return
      }
      case 'topup.failed':
        // Auto-reload / checkout failure: no money moves, just flip the pending record.
        // The wallet stays at its current (possibly low) balance — never debt.
        await this.settleTopUpRecord(manager, event, 'failed')
        return
      case 'method.saved': {
        if (event.organizationId) {
          // Ensure the wallet row exists first — a card can be saved before any wallet
          // activity, where a bare UPDATE would match zero rows and silently drop the flag.
          await this.wallet.getOrCreateWallet(event.organizationId)
          await manager.update(Wallet, { organizationId: event.organizationId }, { creditCardConnected: true })
        }
        return
      }
      case 'refund.succeeded':
        // TODO(stripe, M2): reverse the wallet (debit the paid pool by the refunded
        // amount). Deferred — refund/chargeback policy (PRD Q15) is still open.
        this.logger.warn(`refund webhook ${event.eventId} received; wallet reversal not wired yet`)
        return
    }
  }

  /**
   * Close out the pending top_up_record this webhook resolves (matched by the
   * provider checkout ref), and on success link the settlement ledger row.
   * A no-op when the event carries no provider ref.
   */
  private async settleTopUpRecord(
    manager: EntityManager,
    event: VerifiedWebhookEvent,
    status: Extract<TopUpStatus, 'paid' | 'failed'>,
  ): Promise<void> {
    if (!event.providerRef) return
    const walletTransactionId =
      status === 'paid'
        ? ((await manager.findOne(WalletTransaction, { where: { providerEventId: event.eventId } }))?.id ?? null)
        : null
    await manager.update(TopUpRecord, { stripeSessionId: event.providerRef }, { status, walletTransactionId })
  }
}
