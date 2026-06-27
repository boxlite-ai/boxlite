/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'
import { StoredBillingStatus } from '../wallet/wallet-math'

/**
 * The org's USD wallet — two pools (free → paid). Balances here are a
 * materialized cache of `SUM(wallet_transaction)`; the transaction ledger is the
 * source of truth. `lockVersion` gives optimistic concurrency (Lago lock_version):
 * a debit reads the version, computes, then `UPDATE ... WHERE lockVersion = ?`,
 * retrying on conflict — never last-write-wins. Only `{trial,active,suspended,
 * closed}` are stored; `low_balance`/`zero_balance` are derived from the balance
 * so they can't drift (OpenMeter StatusAt).
 */
@Entity()
@Index('wallet_org_idx', ['organizationId'], { unique: true })
@Check('wallet_free_non_negative', '"freeBalanceCents" >= 0')
@Check('wallet_paid_non_negative', '"paidBalanceCents" >= 0')
export class Wallet {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column()
  organizationId: string

  /** = free + paid (settled). Materialized; truth is SUM(transactions). */
  @Column({ type: 'bigint', default: 0 })
  balanceCents: string

  /** Includes an estimate of unsettled open-period usage (Lago ongoing_balance). */
  @Column({ type: 'bigint', default: 0 })
  ongoingBalanceCents: string

  @Column({ type: 'bigint', default: 0 })
  freeBalanceCents: string

  @Column({ type: 'bigint', default: 0 })
  paidBalanceCents: string

  /** Free-pool overall expiry (per-lot expiry lives on the transactions). */
  @Column({ type: 'timestamptz', nullable: true })
  freeExpiresAt: Date | null

  @Column({ type: 'varchar', default: 'trial' })
  billingStatus: StoredBillingStatus

  /** Risk-control freeze — orthogonal to balance (Lago expiration/alert split). */
  @Column({ type: 'boolean', default: false })
  frozen: boolean

  /** Optimistic-lock token; bumped on every balance mutation. */
  @Column({ type: 'int', default: 0 })
  lockVersion: number

  // ---- auto-reload (PRD §7.3) ----
  @Column({ type: 'bigint', nullable: true })
  autoTopupThresholdCents: string | null

  @Column({ type: 'bigint', nullable: true })
  autoTopupTargetCents: string | null

  /** True once a reusable off-session payment method is stored (Stripe SetupIntent). */
  @Column({ type: 'boolean', default: false })
  creditCardConnected: boolean

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date
}
