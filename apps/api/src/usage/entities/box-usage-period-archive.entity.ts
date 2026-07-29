/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'
import { BoxClass } from '../../box/enums/box-class.enum'
import { RegionType } from '../../region/enums/region-type.enum'
import { BoxUsagePeriod } from './box-usage-period.entity'

// Duplicate of BoxUsagePeriod. It only contains closed periods and keeps the active table lightweight.
@Entity('box_usage_period_archive')
@Index('box_usage_period_archive_organization_end_idx', ['organizationId', 'endAt'])
export class BoxUsagePeriodArchive {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column()
  boxId: string

  @Column()
  // Redundant property to optimize billing queries.
  organizationId: string

  @Column({ type: 'timestamp with time zone' })
  startAt: Date

  @Column({ type: 'timestamp with time zone' })
  endAt: Date

  @Column({ type: 'timestamp with time zone', nullable: true })
  computeBillableUntil: Date | null

  @Column({
    type: 'bigint',
    nullable: true,
    transformer: {
      to: (value: number | null) => value,
      from: (value: string | null) => (value === null ? null : Number(value)),
    },
  })
  runtimeGeneration: number | null

  @Column({ type: 'uuid', nullable: true })
  runnerEpoch: string | null

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

  @Column({ type: 'character varying', default: BoxClass.SMALL })
  boxClass: BoxClass = BoxClass.SMALL

  @Column({ type: 'character varying', default: RegionType.SHARED })
  regionType: string = RegionType.SHARED

  public static fromBoxUsagePeriod(usagePeriod: BoxUsagePeriod) {
    const usagePeriodEntity = new BoxUsagePeriodArchive()
    usagePeriodEntity.id = usagePeriod.id
    usagePeriodEntity.boxId = usagePeriod.boxId
    usagePeriodEntity.organizationId = usagePeriod.organizationId
    usagePeriodEntity.startAt = usagePeriod.startAt
    usagePeriodEntity.endAt = usagePeriod.endAt as Date
    usagePeriodEntity.computeBillableUntil = usagePeriod.computeBillableUntil
    usagePeriodEntity.runtimeGeneration = usagePeriod.runtimeGeneration
    usagePeriodEntity.runnerEpoch = usagePeriod.runnerEpoch
    usagePeriodEntity.cpu = usagePeriod.cpu
    usagePeriodEntity.gpu = usagePeriod.gpu
    usagePeriodEntity.mem = usagePeriod.mem
    usagePeriodEntity.disk = usagePeriod.disk
    usagePeriodEntity.region = usagePeriod.region
    usagePeriodEntity.boxClass = usagePeriod.boxClass
    usagePeriodEntity.regionType = usagePeriod.regionType
    return usagePeriodEntity
  }
}
