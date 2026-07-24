/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Check, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'
import { BoxClass } from '../../box/enums/box-class.enum'
import { RegionType } from '../../region/enums/region-type.enum'

@Entity('box_usage_period')
@Index('box_usage_period_box_end_idx', ['boxId', 'endAt'])
@Index('box_usage_period_organization_end_idx', ['organizationId', 'endAt'])
@Index('box_usage_period_one_open_per_box_idx', ['boxId'], { unique: true, where: '"endAt" IS NULL' })
@Check('box_usage_period_non_negative_duration', '"endAt" IS NULL OR "endAt" >= "startAt"')
@Check(
  'box_usage_period_compute_cap',
  '(cpu = 0 AND gpu = 0 AND mem = 0) OR ("computeBillableUntil" IS NOT NULL AND "runtimeGeneration" IS NOT NULL AND "runnerEpoch" IS NOT NULL)',
)
@Check(
  'box_usage_period_compute_duration',
  '"computeBillableUntil" IS NULL OR ("computeBillableUntil" >= "startAt" AND ("endAt" IS NULL OR "endAt" <= "computeBillableUntil"))',
)
export class BoxUsagePeriod {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column()
  boxId: string

  @Column()
  // Redundant property to optimize billing queries.
  organizationId: string

  @Column({ type: 'timestamp with time zone' })
  startAt: Date

  @Column({ type: 'timestamp with time zone', nullable: true })
  endAt: Date | null

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
    const usagePeriodEntity = new BoxUsagePeriod()
    usagePeriodEntity.boxId = usagePeriod.boxId
    usagePeriodEntity.organizationId = usagePeriod.organizationId
    usagePeriodEntity.startAt = usagePeriod.startAt
    usagePeriodEntity.endAt = usagePeriod.endAt
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
