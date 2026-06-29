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
        const record = await this.lockPendingTopUpRecord(manager, event)
        if (!record) {
          this.logger.log(`topup webhook ${event.eventId} has no pending record for ${event.providerRef}; ignored`)
          return
        }
        await this.wallet.topUpWithin(
          manager,
          record.organizationId,
          Number(record.amountCents),
          'manual',
          event.eventId,
        )
        const walletTransactionId =
          (await manager.findOne(WalletTransaction, { where: { providerEventId: event.eventId } }))?.id ?? null
        await this.settleTopUpRecord(manager, record, 'paid', walletTransactionId)
        return
      }
      case 'topup.failed': {
        // Auto-reload / checkout failure: no money moves, just flip the pending record.
        // The wallet stays at its current (possibly low) balance — never debt.
        const record = await this.lockPendingTopUpRecord(manager, event)
        if (!record) return
        await this.settleTopUpRecord(manager, record, 'failed', null)
        return
      }
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
   * Lock the still-pending top_up_record this provider event resolves. The
   * record is the source of truth for org + amount; webhook payload metadata
   * only identifies the provider checkout session.
   */
  private lockPendingTopUpRecord(manager: EntityManager, event: VerifiedWebhookEvent): Promise<TopUpRecord | null> {
    if (!event.providerRef) throw new Error(`topup webhook ${event.eventId} missing providerRef`)
    return manager.findOne(TopUpRecord, {
      where: { stripeSessionId: event.providerRef, status: 'pending' },
      lock: { mode: 'pessimistic_write' },
    })
  }

  private async settleTopUpRecord(
    manager: EntityManager,
    record: TopUpRecord,
    status: Extract<TopUpStatus, 'paid' | 'failed'>,
    walletTransactionId: string | null,
  ): Promise<void> {
    const result = await manager.update(
      TopUpRecord,
      { id: record.id, status: 'pending' },
      { status, walletTransactionId },
    )
    if (result.affected !== 1) {
      throw new Error(`top_up_record ${record.id} was not settled as ${status}`)
    }
  }
}
