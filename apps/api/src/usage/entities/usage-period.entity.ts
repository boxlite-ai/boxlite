/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'

/**
 * One billable usage segment for a box (alloc side).
 *
 * Built in the control-plane from box lifecycle events (Daytona-style): a new
 * period opens when the billing kind changes (running ↔ stopped) and closes
 * (`periodEnd` set) at the next change or destroy. `actual*` columns are filled
 * later from the Rust cgroup metering (over-commit/COGS); they are nullable and
 * not required for billing.
 */
@Entity()
@Index('usage_period_box_period_start_idx', ['boxId', 'periodStart'], { unique: true })
@Index('usage_period_org_period_start_idx', ['organizationId', 'periodStart'])
export class UsagePeriod {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column()
  boxId: string

  @Column()
  organizationId: string

  @Column({ nullable: true })
  region: string

  @Column({ type: 'timestamptz' })
  periodStart: Date

  /** `null` while the period is still open (box still in this billing kind). */
  @Column({ type: 'timestamptz', nullable: true })
  periodEnd: Date | null

  /** Billing kind: `running` (cpu+ram+disk) or `stopped` (disk only). */
  @Column()
  kind: string

  // ---- allocated quantities (billing basis, from box spec) ----
  @Column({ type: 'int' })
  allocCpu: number

  @Column({ type: 'int' })
  allocMemGib: number

  @Column({ type: 'int' })
  allocDiskGib: number

  // ---- actual consumption (over-commit/COGS; filled later by Rust metering) ----
  @Column({ type: 'double precision', nullable: true })
  actualCpuSeconds: number | null

  @Column({ type: 'bigint', nullable: true })
  actualRssAvgBytes: string | null

  @Column({ type: 'bigint', nullable: true })
  actualRssPeakBytes: string | null

  @Column({ type: 'int', nullable: true })
  sampleCount: number | null

  /** `false` = period was force-closed by crash recovery (treat as suspect). */
  @Column({ type: 'boolean', default: true })
  sealed: boolean

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date
}
