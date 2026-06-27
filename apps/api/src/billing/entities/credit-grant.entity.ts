/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'
import { Pool } from '../wallet/wallet-math'

export type GrantType = 'grant' | 'revoke'

/**
 * A support-initiated balance adjustment (PRD L-3/L-4). Immutable audit record —
 * a grant and its revoke are two separate rows, never an in-place edit
 * (OpenMeter VoidGrant). The actual money movement is a corresponding
 * `wallet_transaction`; this table is the "who/why" trail.
 */
@Entity()
@Index('credit_grant_org_idx', ['organizationId', 'createdAt'])
export class CreditGrant {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column()
  organizationId: string

  @Column({ type: 'bigint' })
  amountCents: string

  @Column({ type: 'varchar' })
  type: GrantType

  @Column({ type: 'varchar' })
  pool: Pool

  @Column()
  reason: string

  @Column({ type: 'text', nullable: true })
  note: string | null

  @Column()
  operatorId: string

  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date | null

  /** The ledger row this grant produced. */
  @Column({ type: 'uuid', nullable: true })
  walletTransactionId: string | null

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date
}
