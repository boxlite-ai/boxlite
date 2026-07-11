/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'
import type { PricingSegment, UsageTotals } from '../rating/rate-math'

@Entity('rated_period')
@Index('rated_period_usage_archive_idx', ['usagePeriodArchiveId'], { unique: true })
@Index('rated_period_org_rated_at_idx', ['organizationId', 'ratedAt'])
export class RatedPeriod {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ type: 'uuid' })
  usagePeriodArchiveId: string

  @Column({ type: 'uuid' })
  organizationId: string

  @Column()
  boxId: string

  @Column({ type: 'jsonb' })
  pricingSegments: PricingSegment[]

  @Column({ type: 'jsonb' })
  usageTotals: UsageTotals

  @Column({ type: 'numeric', precision: 38, scale: 3 })
  billedSeconds: string

  @Column({ type: 'numeric', precision: 38, scale: 18 })
  preciseCents: string

  @Column({ type: 'bigint' })
  ratedCents: string

  @Column({ type: 'timestamp with time zone', default: () => 'now()' })
  ratedAt: Date
}
