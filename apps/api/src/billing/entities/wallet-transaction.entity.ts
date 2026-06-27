/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'
import { Pool } from '../wallet/wallet-math'

export type TxDirection = 'inbound' | 'outbound'
export type TxStatus = 'pending' | 'settled' | 'failed'
export type TxSource = 'manual' | 'threshold' | 'usage' | 'grant' | 'refund' | 'chargeback'

/**
 * Append-only wallet ledger (Lago's core). Every credit (top-up/grant) and debit
 * (usage) is a row; nothing is ever updated except `remainingCents` (a credit lot
 * burning down) and `voidedAt` (a reversal stamp — Lago/OpenMeter never delete).
 * Inbound rows carry `remainingCents` + `expiresAt` and burn in `priority` order
 * (free=1, paid=2). The wallet's materialized balance is `SUM` of these rows.
 */
@Entity()
@Index('wallet_tx_wallet_idx', ['walletId', 'createdAt'])
@Index('wallet_tx_provider_event_idx', ['providerEventId'], { unique: true, where: '"providerEventId" IS NOT NULL' })
@Check('wallet_tx_remaining_non_negative', '"remainingCents" IS NULL OR "remainingCents" >= 0')
export class WalletTransaction {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column()
  walletId: string

  @Column({ type: 'varchar' })
  pool: Pool

  /** Consumption order: free=1, paid=2 (lower drains first). */
  @Column({ type: 'int' })
  priority: number

  @Column({ type: 'varchar' })
  direction: TxDirection

  @Column({ type: 'bigint' })
  amountCents: string

  /** Inbound only: remaining spendable balance of this lot (burns toward 0). */
  @Column({ type: 'bigint', nullable: true })
  remainingCents: string | null

  /** Inbound free lots only: when this credit lapses. */
  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date | null

  @Column({ type: 'varchar', default: 'settled' })
  status: TxStatus

  @Column({ type: 'varchar' })
  source: TxSource

  /** Outbound only: which rated period this debit paid for. */
  @Column({ type: 'uuid', nullable: true })
  ratedPeriodId: string | null

  /** Reversal stamp — set instead of deleting the row. */
  @Column({ type: 'timestamptz', nullable: true })
  voidedAt: Date | null

  /** Stripe charge/refund reference (the payment-provider seam). */
  @Column({ type: 'text', nullable: true })
  stripeRef: string | null

  /** Provider webhook event id — UNIQUE (partial) for idempotent ingest. */
  @Column({ type: 'text', nullable: true })
  providerEventId: string | null

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date
}
