/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'

export type BillingStatus = 'trial' | 'active' | 'zero_balance'

@Entity('wallet')
@Index('wallet_organization_idx', ['organizationId'], { unique: true })
@Check('wallet_free_balance_non_negative', '"freeBalanceCents" >= 0')
@Check('wallet_remainder_range', '"settlementRemainderCents" >= 0 AND "settlementRemainderCents" < 1')
export class Wallet {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ type: 'uuid' })
  organizationId: string

  @Column({ type: 'bigint', default: 0 })
  freeBalanceCents: string

  @Column({ type: 'bigint', default: 0 })
  paidBalanceCents: string

  @Column({ type: 'numeric', precision: 38, scale: 18, default: 0 })
  settlementRemainderCents: string

  @Column({ type: 'timestamp with time zone', nullable: true })
  freeExpiresAt: Date | null

  @Column({ type: 'character varying', default: 'trial' })
  billingStatus: BillingStatus

  @Column({ type: 'character varying', nullable: true })
  paymentProviderCustomerId: string | null

  @Column({ type: 'character varying', nullable: true })
  paymentProviderMethodId: string | null

  @Column({ type: 'character varying', nullable: true })
  paymentMethodBrand: string | null

  @Column({ type: 'character varying', nullable: true })
  paymentMethodLast4: string | null

  @Column({ type: 'boolean', default: false })
  autoReloadEnabled: boolean

  @Column({ type: 'bigint', nullable: true })
  autoReloadThresholdCents: string | null

  @Column({ type: 'bigint', nullable: true })
  autoReloadTargetCents: string | null

  @Column({ type: 'timestamp with time zone', nullable: true })
  autoReloadNextAttemptAt: Date | null

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date
}
