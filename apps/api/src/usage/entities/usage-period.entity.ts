/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'

/**
 * One usage segment for a box — the whole MVP timing model in one table.
 *
 * The idea (modelled on Daytona): a box's life is a chain of segments. A segment
 * opens when the box's billing kind changes (running ↔ stopped) and closes
 * (`periodEnd` set) at the next change or when the box is destroyed. We store the
 * box's allocated spec (cpu/mem/disk) + the start/end timestamps and NOTHING
 * else — the billable amount is `spec × duration`, computed at read time. No
 * seconds stored, no money stored.
 *
 * MVP scope: this is deliberately the happy path only. Four protections from the
 * fuller design are intentionally left out and can be layered back without
 * reshaping this table (see usage/README or the OB design doc):
 *   1. actual cgroup columns (real CPU/RAM measured by the Rust engine) — add as
 *      nullable columns later; billing uses alloc, so reads don't depend on them.
 *   2. a reconcile cron (force-closes segments orphaned by a runner crash).
 *   3. a partial-unique "one open segment per box" index (concurrency guard).
 *   4. an end-after-start CHECK + a `sealed` flag (clock-skew / crash markers).
 *
 * The column names + types here match the fuller ledger exactly, so the rating
 * layer (Phase 2) consumes this table unchanged, and the protections above are
 * pure additive migrations.
 */
@Entity()
@Index('usage_period_box_period_start_idx', ['boxId', 'periodStart'])
@Index('usage_period_org_period_start_idx', ['organizationId', 'periodStart'])
export class UsagePeriod {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column()
  boxId: string

  @Column()
  organizationId: string

  @Column({ nullable: true })
  region: string | null

  @Column({ type: 'timestamptz' })
  periodStart: Date

  /** `null` while the segment is still open (box still in this billing kind). */
  @Column({ type: 'timestamptz', nullable: true })
  periodEnd: Date | null

  /**
   * Billing kind: `running` (cpu+ram+disk) or `stopped` (disk only). Stored as
   * a plain varchar holding these literal strings — downstream rating compares
   * `kind === 'running'` literally, so the persisted values must never change.
   */
  @Column()
  kind: 'running' | 'stopped'

  // ---- allocated quantities (the billing basis, snapshotted from the box spec) ----
  @Column({ type: 'int' })
  allocCpu: number

  @Column({ type: 'int' })
  allocMemGib: number

  @Column({ type: 'int' })
  allocDiskGib: number

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date
}
