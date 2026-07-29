/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'
import { BoxClass } from '../../box/enums/box-class.enum'
import { RegionType } from '../../region/enums/region-type.enum'

@Entity('box_usage_periods')
@Index('idx_box_usage_periods_box_end', ['boxId', 'endAt'])
@Index('idx_box_usage_periods_organization_start_end', ['organizationId', 'startAt', 'endAt'])
@Index('box_usage_periods_one_open_period_per_box_idx', ['boxId'], {
  unique: true,
  where: '"endAt" IS NULL',
})
export class BoxUsagePeriod {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column()
  boxId: string

  // Redundant to keep organization-scoped billing queries on the usage ledger.
  @Column()
  organizationId: string

  @Column({ type: 'timestamp with time zone' })
  startAt: Date

  @Column({ type: 'timestamp with time zone', nullable: true })
  endAt: Date | null

  @Column({ type: 'float' })
  cpu: number

  @Column({ type: 'float' })
  gpu: number

  @Column({
    type: 'character varying',
    nullable: true,
    name: 'gpu_type',
  })
  gpuType: string | null

  @Column({ type: 'float' })
  mem: number

  @Column({ type: 'float' })
  disk: number

  @Column()
  region: string

  @Column({
    type: 'character varying',
    default: BoxClass.SMALL,
  })
  // BoxLite has no Daytona runtime-class field; retain its size class as the nearest billing dimension.
  boxClass: BoxClass = BoxClass.SMALL

  @Column({ type: 'character varying', default: RegionType.SHARED })
  regionType: RegionType = RegionType.SHARED

  static fromUsagePeriod(usagePeriod: BoxUsagePeriod): BoxUsagePeriod {
    const newUsagePeriod = new BoxUsagePeriod()
    newUsagePeriod.boxId = usagePeriod.boxId
    newUsagePeriod.organizationId = usagePeriod.organizationId
    newUsagePeriod.startAt = usagePeriod.startAt
    newUsagePeriod.endAt = usagePeriod.endAt
    newUsagePeriod.cpu = usagePeriod.cpu
    newUsagePeriod.gpu = usagePeriod.gpu
    newUsagePeriod.gpuType = usagePeriod.gpuType
    newUsagePeriod.mem = usagePeriod.mem
    newUsagePeriod.disk = usagePeriod.disk
    newUsagePeriod.region = usagePeriod.region
    newUsagePeriod.boxClass = usagePeriod.boxClass
    newUsagePeriod.regionType = usagePeriod.regionType
    return newUsagePeriod
  }
}
