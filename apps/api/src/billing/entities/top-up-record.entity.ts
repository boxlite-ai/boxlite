/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'

export type TopUpSource = 'manual' | 'auto_reload'
export type TopUpStatus = 'pending' | 'paid' | 'failed'

@Entity('top_up_record')
@Index('top_up_record_org_created_idx', ['organizationId', 'createdAt'])
@Index('top_up_record_org_idempotency_idx', ['organizationId', 'idempotencyKey'], { unique: true })
@Index('top_up_record_provider_reference_idx', ['providerReference'], {
  unique: true,
  where: '"providerReference" IS NOT NULL',
})
@Check('top_up_record_positive_amount', '"amountCents" > 0')
export class TopUpRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ type: 'uuid' })
  walletId: string

  @Column({ type: 'uuid' })
  organizationId: string

  @Column({ type: 'bigint' })
  amountCents: string

  @Column({ type: 'character varying' })
  source: TopUpSource

  @Column({ type: 'character varying', default: 'pending' })
  status: TopUpStatus

  @Column({ type: 'character varying' })
  idempotencyKey: string

  @Column({ type: 'character varying', nullable: true })
  providerReference: string | null

  @Column({ type: 'text', nullable: true })
  checkoutUrl: string | null

  @Column({ type: 'text', nullable: true })
  receiptUrl: string | null

  @Column({ type: 'character varying', nullable: true })
  failureCode: string | null

  @Column({ type: 'text', nullable: true })
  failureMessage: string | null

  @Column({ type: 'timestamp with time zone', nullable: true })
  completedAt: Date | null

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date
}
