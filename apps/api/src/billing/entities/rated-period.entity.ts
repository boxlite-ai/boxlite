/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'

/** The frozen rates a rated period was computed against (≈ OpenMeter SnapshotLineQuantity). */
export interface FrozenUnitRates {
  cpuRateCentsPerSec: string
  memRateCentsPerSec: string
  diskRateCentsPerSec: string
  discountFactor: string
}

/**
 * The output of rating one Phase-1 `usage_period`: raw seconds × a frozen rate
 * snapshot = USD. `usagePeriodId` is UNIQUE so re-running the rating sweep is
 * idempotent (one usage period → at most one rated row). Reads never join the
 * live pricing plan — `unitRates` is the source of truth, so price changes can't
 * move a historical bill.
 */
@Entity()
@Index('rated_period_usage_period_idx', ['usagePeriodId'], { unique: true })
@Index('rated_period_org_rated_at_idx', ['organizationId', 'ratedAt'])
export class RatedPeriod {
  @PrimaryGeneratedColumn('uuid')
  id: string

  /** The Phase-1 usage_period this rates. UNIQUE → idempotent rating. */
  @Column()
  usagePeriodId: string

  @Column()
  organizationId: string

  @Column()
  boxId: string

  /** Pricing plan version in force when the usage happened. */
  @Column({ type: 'int' })
  pricingVersion: number

  /** Frozen per-second rates + discount (defensive copy — never re-joined). */
  @Column({ type: 'jsonb' })
  unitRates: FrozenUnitRates

  /** Billed seconds carried from Phase 1 (kept for auditability). */
  @Column({ type: 'numeric', precision: 30, scale: 5 })
  billedSeconds: string

  /** Sub-cent precise value (Lago precise_amount_cents) — keeps accumulation honest. */
  @Column({ type: 'numeric', precision: 30, scale: 5 })
  preciseCents: string

  /** Whole cents actually billed (round-half-up of preciseCents). */
  @Column({ type: 'bigint' })
  ratedCents: string

  @CreateDateColumn({ type: 'timestamptz' })
  ratedAt: Date
}
