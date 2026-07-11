/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'

export type WalletTransactionKind = 'free_grant' | 'usage_debit' | 'adjustment' | 'top_up'

@Entity('wallet_transaction')
@Index('wallet_transaction_wallet_created_idx', ['walletId', 'createdAt'])
@Index('wallet_transaction_org_created_idx', ['organizationId', 'createdAt'])
@Index('wallet_transaction_rated_period_idx', ['ratedPeriodId'], { unique: true })
export class WalletTransaction {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ type: 'uuid' })
  walletId: string

  @Column({ type: 'uuid' })
  organizationId: string

  @Column({ type: 'character varying' })
  kind: WalletTransactionKind

  @Column({ type: 'bigint' })
  amountCents: string

  @Column({ type: 'character varying' })
  source: string

  @Column({ type: 'uuid', nullable: true })
  ratedPeriodId: string | null

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date
}
