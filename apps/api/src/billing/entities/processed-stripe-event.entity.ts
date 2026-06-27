/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm'

/**
 * Webhook idempotency ledger (Stripe official guidance: "log event IDs, don't
 * reprocess"). The Stripe event id is the PK; inserting it in the same
 * transaction as the balance change means a duplicate webhook hits the unique
 * key, rolls the transaction back, and never double-credits the wallet.
 */
@Entity()
export class ProcessedStripeEvent {
  @PrimaryColumn({ type: 'text' })
  stripeEventId: string

  @Column({ type: 'text' })
  eventType: string

  @CreateDateColumn({ type: 'timestamptz' })
  processedAt: Date
}
