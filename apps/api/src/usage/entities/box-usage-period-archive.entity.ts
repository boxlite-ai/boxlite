/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'
import { BoxClass } from '../../box/enums/box-class.enum'
import { RegionType } from '../../region/enums/region-type.enum'
import { BoxUsagePeriod } from './box-usage-period.entity'

// Closed periods move here so lifecycle writes only contend on the active table.
@Entity('box_usage_periods_archive')
@Index('idx_box_usage_periods_archive_organization_start_end', ['organizationId', 'startAt', 'endAt'])
@Index('idx_box_usage_periods_archive_box_start_end', ['boxId', 'startAt', 'endAt'])
export class BoxUsagePeriodArchive {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column()
  boxId: string

  // Redundant to keep organization-scoped billing queries on the usage ledger.
  @Column()
  organizationId: string

  @Column({ type: 'timestamp with time zone' })
  startAt: Date

  @Column({ type: 'timestamp with time zone' })
  endAt: Date

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
  boxClass: BoxClass = BoxClass.SMALL

  @Column({ type: 'character varying', default: RegionType.SHARED })
  regionType: RegionType = RegionType.SHARED

  static fromUsagePeriod(usagePeriod: BoxUsagePeriod): BoxUsagePeriodArchive {
    const archivedUsagePeriod = new BoxUsagePeriodArchive()
    archivedUsagePeriod.boxId = usagePeriod.boxId
    archivedUsagePeriod.organizationId = usagePeriod.organizationId
    archivedUsagePeriod.startAt = usagePeriod.startAt
    archivedUsagePeriod.endAt = usagePeriod.endAt as Date
    archivedUsagePeriod.cpu = usagePeriod.cpu
    archivedUsagePeriod.gpu = usagePeriod.gpu
    archivedUsagePeriod.gpuType = usagePeriod.gpuType
    archivedUsagePeriod.mem = usagePeriod.mem
    archivedUsagePeriod.disk = usagePeriod.disk
    archivedUsagePeriod.region = usagePeriod.region
    archivedUsagePeriod.boxClass = usagePeriod.boxClass
    archivedUsagePeriod.regionType = usagePeriod.regionType
    return archivedUsagePeriod
  }
}
