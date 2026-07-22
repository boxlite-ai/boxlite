/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Check, Column, CreateDateColumn, Entity, Exclusion, Index, PrimaryGeneratedColumn } from 'typeorm'
import type { SubscriptionPlanCode } from '../subscription/subscription.types'

@Entity('subscription_entitlement')
@Index('subscription_entitlement_period_effective_idx', ['subscriptionPeriodId', 'effectiveFrom'])
@Index('subscription_entitlement_org_effective_idx', ['organizationId', 'effectiveFrom', 'effectiveTo'])
@Check('subscription_entitlement_valid_interval', '"effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom"')
@Check(
  'subscription_entitlement_positive_overage_multipliers',
  '"overageCpuMultiplier" >= 1 AND "overageMemMultiplier" >= 1 AND "overageDiskMultiplier" >= 1 AND "overageGpuMultiplier" >= 1',
)
@Exclusion(
  'subscription_entitlement_period_no_overlap',
  `USING gist ("subscriptionPeriodId" WITH =, (tstzrange("effectiveFrom", COALESCE("effectiveTo", 'infinity'::timestamptz), '[)')) WITH &&)`,
)
export class SubscriptionEntitlement {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ type: 'uuid' })
  subscriptionPeriodId: string

  @Column({ type: 'uuid' })
  organizationId: string

  @Column({ type: 'character varying' })
  planCode: SubscriptionPlanCode

  @Column({ type: 'timestamp with time zone' })
  effectiveFrom: Date

  @Column({ type: 'timestamp with time zone', nullable: true })
  effectiveTo: Date | null

  @Column({ type: 'numeric', precision: 20, scale: 9 })
  overageCpuMultiplier: string

  @Column({ type: 'numeric', precision: 20, scale: 9 })
  overageMemMultiplier: string

  @Column({ type: 'numeric', precision: 20, scale: 9 })
  overageDiskMultiplier: string

  @Column({ type: 'numeric', precision: 20, scale: 9 })
  overageGpuMultiplier: string

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date
}
