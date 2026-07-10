/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Check, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'
import { BoxClass } from '../../box/enums/box-class.enum'
import { RegionType } from '../../region/enums/region-type.enum'
import type { UsagePeriodKind } from '../metering/usage-period-math'

@Entity('box_usage_period')
@Index('box_usage_period_box_end_idx', ['boxId', 'endAt'])
@Index('box_usage_period_org_start_idx', ['organizationId', 'startAt'])
@Index('box_usage_period_one_open_per_box_idx', ['boxId'], { unique: true, where: '"endAt" IS NULL' })
@Check('box_usage_period_end_after_start', '"endAt" IS NULL OR "endAt" >= "startAt"')
export class UsagePeriod {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column()
  boxId: string

  @Column()
  organizationId: string

  @Column({ nullable: true })
  region: string | null

  @Column({ type: 'timestamp with time zone' })
  startAt: Date

  @Column({ type: 'timestamp with time zone', nullable: true })
  endAt: Date | null

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

  @Column({ type: 'character varying', default: BoxClass.SMALL })
  boxClass: BoxClass = BoxClass.SMALL

  @Column({ type: 'character varying', default: RegionType.SHARED })
  regionType: string = RegionType.SHARED

  static fromUsagePeriod(period: UsagePeriod): UsagePeriod {
    const next = new UsagePeriod()
    Object.assign(next, period)
    delete (next as Partial<UsagePeriod>).id
    return next
  }
}
