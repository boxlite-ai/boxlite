/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'

/**
 * A versioned pricing snapshot (canon I7). Rates are cents-per-unit-second as
 * numeric strings (sub-cent allowed). Changing a price = INSERT a new version +
 * stamp `effectiveTo` on the old one; rate columns are NEVER updated, so a
 * historical bill always re-computes to the same number. "active" is derived
 * (`effectiveFrom <= now < effectiveTo`), not stored — OpenMeter StatusAt.
 */
@Entity()
@Index('pricing_plan_version_idx', ['version'], { unique: true })
@Index('pricing_plan_effective_idx', ['effectiveFrom'])
export class PricingPlan {
  @PrimaryGeneratedColumn('uuid')
  id: string

  /** Monotonic version; INSERT a new row to change price. */
  @Column({ type: 'int' })
  version: number

  // ---- per-second rates (cents, sub-cent allowed) — frozen, never updated ----
  @Column({ type: 'numeric', precision: 30, scale: 10 })
  cpuRateCentsPerSec: string

  @Column({ type: 'numeric', precision: 30, scale: 10 })
  memRateCentsPerSec: string

  @Column({ type: 'numeric', precision: 30, scale: 10 })
  diskRateCentsPerSec: string

  // ---- wallet/trial knobs (PRD §13.1 P-1) ----
  @Column({ type: 'bigint' })
  warnThresholdCents: string

  @Column({ type: 'bigint' })
  defaultGrantCents: string

  // ---- effective window ----
  @Column({ type: 'timestamptz' })
  effectiveFrom: Date

  /** `null` = current version; stamped when a newer version supersedes it. */
  @Column({ type: 'timestamptz', nullable: true })
  effectiveTo: Date | null

  @Column({ nullable: true })
  createdBy: string

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date
}
