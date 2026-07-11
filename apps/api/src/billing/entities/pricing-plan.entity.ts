/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Check, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'

@Entity('pricing_plan')
@Index('pricing_plan_version_idx', ['version'], { unique: true })
@Index('pricing_plan_effective_idx', ['effectiveFrom'])
@Check('pricing_plan_effective_interval', '"effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom"')
@Check(
  'pricing_plan_non_negative_rates',
  '"cpuRateCentsPerSec" >= 0 AND "memRateCentsPerSec" >= 0 AND "diskRateCentsPerSec" >= 0 AND "gpuRateCentsPerSec" >= 0',
)
export class PricingPlan {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ type: 'int' })
  version: number

  @Column({ type: 'numeric', precision: 38, scale: 18 })
  cpuRateCentsPerSec: string

  @Column({ type: 'numeric', precision: 38, scale: 18 })
  memRateCentsPerSec: string

  @Column({ type: 'numeric', precision: 38, scale: 18 })
  diskRateCentsPerSec: string

  @Column({ type: 'numeric', precision: 38, scale: 18 })
  gpuRateCentsPerSec: string

  @Column({ type: 'timestamp with time zone' })
  effectiveFrom: Date

  @Column({ type: 'timestamp with time zone', nullable: true })
  effectiveTo: Date | null

  @Column({ type: 'timestamp with time zone', default: () => 'now()' })
  createdAt: Date
}
