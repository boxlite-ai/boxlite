/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'

export type TopUpMethod = 'manual' | 'auto'
export type TopUpStatus = 'pending' | 'paid' | 'failed'

/**
 * A top-up intent (PRD J8). Two-stage (Stripe): the row is `pending` at intent
 * creation — the wallet balance does NOT move — and flips to `paid` only when the
 * provider webhook confirms, at which point the linked `wallet_transaction`
 * settles. `failed` carries no money movement (auto-reload failure degrades back
 * to low_balance, never debt).
 */
@Entity()
@Index('top_up_org_idx', ['organizationId', 'createdAt'])
export class TopUpRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column()
  organizationId: string

  @Column({ type: 'bigint' })
  amountCents: string

  @Column({ type: 'varchar' })
  method: TopUpMethod

  @Column({ type: 'varchar', default: 'pending' })
  status: TopUpStatus

  /** The (pending → settled) ledger row this intent will settle. */
  @Column({ type: 'uuid', nullable: true })
  walletTransactionId: string | null

  // ---- Stripe seam ----
  @Column({ type: 'text', nullable: true })
  stripeSessionId: string | null

  @Column({ type: 'text', nullable: true })
  stripePaymentIntentId: string | null

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date
}
