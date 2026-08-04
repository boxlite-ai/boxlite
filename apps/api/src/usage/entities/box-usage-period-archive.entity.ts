/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'
import { BoxUsagePeriod } from './box-usage-period.entity'

// Duplicate of BoxUsagePeriod
// Used to archive usage periods and keep the original table lightweight
// Will only contain closed usage periods
@Entity('box_usage_periods_archive')
@Index('box_usage_periods_archive_box_start_uidx', ['boxId', 'startAt'], { unique: true })
// commerce-rs's billing cron scans WHERE billing_status = 'unbilled' ORDER BY
// endAt every round. The (boxId, startAt) index above can't serve that -- it
// has neither column -- so without this partial index the scan degrades to a
// full sort of the archive as it grows. Billed rows drop out of the index
// entirely, keeping it small regardless of archive size.
@Index('box_usage_periods_archive_unbilled_idx', ['endAt'], {
  where: `"billing_status" = 'unbilled'`,
})
export class BoxUsagePeriodArchive {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ name: 'boxId' })
  boxId: string

  @Column()
  // Redundant property to optimize billing queries
  organizationId: string

  @Column({ type: 'timestamp with time zone' })
  startAt: Date

  @Column({ type: 'timestamp with time zone' })
  endAt: Date

  @Column({ type: 'float' })
  cpu: number

  @Column({ type: 'float' })
  gpu: number

  @Column({ type: 'float' })
  mem: number

  @Column({ type: 'float' })
  disk: number

  @Column()
  region: string

  // commerce-rs's billing queue: 'unbilled' until its billing cron claims the
  // row with a compare-and-swap UPDATE (billingStatus 'unbilled' -> 'billed').
  // Owned by commerce-rs; this app only ever sets the 'unbilled' default on
  // insert (see fromUsagePeriod below) and never updates it directly.
  @Column({ name: 'billing_status', default: 'unbilled' })
  billingStatus: string

  public static fromUsagePeriod(usagePeriod: BoxUsagePeriod) {
    const usagePeriodEntity = new BoxUsagePeriodArchive()
    usagePeriodEntity.boxId = usagePeriod.boxId
    usagePeriodEntity.organizationId = usagePeriod.organizationId
    usagePeriodEntity.startAt = usagePeriod.startAt
    usagePeriodEntity.endAt = usagePeriod.endAt
    usagePeriodEntity.cpu = usagePeriod.cpu
    usagePeriodEntity.gpu = usagePeriod.gpu
    usagePeriodEntity.mem = usagePeriod.mem
    usagePeriodEntity.disk = usagePeriod.disk
    usagePeriodEntity.region = usagePeriod.region
    return usagePeriodEntity
  }
}
