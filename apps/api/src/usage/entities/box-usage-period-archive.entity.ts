/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Check, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'
import { BoxUsagePeriod } from './box-usage-period.entity'

// Duplicate of BoxUsagePeriod
// Used to archive usage periods and keep the original table lightweight
// Will only contain closed usage periods
@Entity('box_usage_periods_archive')
@Check('box_usage_periods_archive_end_after_start_check', '"endAt" >= "startAt"')
@Index('box_usage_periods_archive_source_period_uidx', ['sourceUsagePeriodId'], {
  unique: true,
  where: '"sourceUsagePeriodId" IS NOT NULL',
})
export class BoxUsagePeriodArchive {
  @PrimaryGeneratedColumn('uuid')
  id: string

  // Rows archived before this identity was introduced remain null. Every new
  // archive copies the source ledger UUID, which makes retries idempotent
  // without conflating two legitimate periods that share a timestamp.
  @Column({ type: 'uuid', nullable: true })
  sourceUsagePeriodId: string | null

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

  public static fromUsagePeriod(usagePeriod: BoxUsagePeriod) {
    const usagePeriodEntity = new BoxUsagePeriodArchive()
    usagePeriodEntity.sourceUsagePeriodId = usagePeriod.id
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
