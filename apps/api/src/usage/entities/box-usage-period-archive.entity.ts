/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm'
import { BoxUsagePeriod } from './box-usage-period.entity'
import { BoxClass } from '../../box/enums/box-class.enum'
import { GpuType } from '../../box/enums/gpu-type.enum'
import { RegionType } from '../../region/enums/region-type.enum'

// Duplicate of BoxUsagePeriod
// Used to archive usage periods and keep the original table lightweight
// Will only contain closed usage periods
@Entity('box_usage_periods_archive')
export class BoxUsagePeriodArchive {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column()
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

  @Column({
    type: 'character varying',
    nullable: true,
    name: 'gpu_type',
  })
  gpuType: GpuType | null

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
  regionType: string

  public static fromUsagePeriod(usagePeriod: BoxUsagePeriod) {
    const usagePeriodEntity = new BoxUsagePeriodArchive()
    usagePeriodEntity.boxId = usagePeriod.boxId
    usagePeriodEntity.organizationId = usagePeriod.organizationId
    usagePeriodEntity.startAt = usagePeriod.startAt
    usagePeriodEntity.endAt = usagePeriod.endAt
    usagePeriodEntity.cpu = usagePeriod.cpu
    usagePeriodEntity.gpu = usagePeriod.gpu
    usagePeriodEntity.gpuType = usagePeriod.gpuType
    usagePeriodEntity.mem = usagePeriod.mem
    usagePeriodEntity.disk = usagePeriod.disk
    usagePeriodEntity.region = usagePeriod.region
    usagePeriodEntity.boxClass = usagePeriod.boxClass
    usagePeriodEntity.regionType = usagePeriod.regionType
    return usagePeriodEntity
  }
}
