/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Check, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'
import type { UsagePeriodKind } from '../metering/usage-period-math'
import { UsagePeriod } from './usage-period.entity'

@Entity('usage_period_archive')
@Index('usage_period_archive_source_period_idx', ['sourcePeriodId'], { unique: true })
@Index('usage_period_archive_org_start_idx', ['organizationId', 'startAt'])
@Index('usage_period_archive_box_start_idx', ['boxId', 'startAt'])
@Check('usage_period_archive_end_after_start', '"endAt" >= "startAt"')
export class UsagePeriodArchive {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column()
  sourcePeriodId: string

  @Column()
  boxId: string

  @Column()
  organizationId: string

  @Column({ nullable: true })
  region: string | null

  @Column({ type: 'timestamp with time zone' })
  startAt: Date

  @Column({ type: 'timestamp with time zone' })
  endAt: Date

  @Column({ type: 'character varying' })
  kind: UsagePeriodKind

  @Column({ type: 'float' })
  cpu: number

  @Column({ type: 'float' })
  gpu: number

  @Column({ type: 'float' })
  mem: number

  @Column({ type: 'float' })
  disk: number

  @Column({ type: 'double precision', nullable: true })
  actualCpuSeconds: number | null

  @Column({ type: 'bigint', nullable: true })
  actualRssAvgBytes: string | null

  @Column({ type: 'bigint', nullable: true })
  actualRssPeakBytes: string | null

  @Column({ type: 'int', nullable: true })
  sampleCount: number | null

  static fromUsagePeriod(period: UsagePeriod): UsagePeriodArchive {
    if (!period.endAt) {
      throw new Error(`usage period ${period.id} cannot be archived while open`)
    }

    const archived = new UsagePeriodArchive()
    archived.sourcePeriodId = period.id
    archived.boxId = period.boxId
    archived.organizationId = period.organizationId
    archived.region = period.region
    archived.startAt = period.startAt
    archived.endAt = period.endAt
    archived.kind = period.kind
    archived.cpu = period.cpu
    archived.gpu = period.gpu
    archived.mem = period.mem
    archived.disk = period.disk
    archived.actualCpuSeconds = period.actualCpuSeconds
    archived.actualRssAvgBytes = period.actualRssAvgBytes
    archived.actualRssPeakBytes = period.actualRssPeakBytes
    archived.sampleCount = period.sampleCount
    return archived
  }
}
