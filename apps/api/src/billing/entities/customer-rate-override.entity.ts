/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'

/** Per-customer rate override (PRD §13.1 P-2). `effectiveRates` beats `discountFactor`. */
@Entity()
@Index('rate_override_org_active_idx', ['organizationId'], { unique: true, where: '"effectiveTo" IS NULL' })
export class CustomerRateOverride {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column()
  organizationId: string

  /** e.g. 0.85 = 15% off list. */
  @Column({ type: 'numeric', precision: 6, scale: 5, nullable: true })
  discountFactor: string | null

  /** Full per-second rate replacement (cents/sec) — wins over discountFactor. */
  @Column({ type: 'jsonb', nullable: true })
  effectiveRates: { cpu: string; mem: string; disk: string } | null

  @Column({ type: 'timestamptz' })
  effectiveFrom: Date

  @Column({ type: 'timestamptz', nullable: true })
  effectiveTo: Date | null

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date
}
