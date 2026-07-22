/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'
import type { SubscriptionPlanCode } from '../subscription/subscription.types'

@Entity('subscription_plan')
@Index('subscription_plan_code_idx', ['code'], { unique: true })
@Index('subscription_plan_rank_idx', ['rank'], { unique: true })
@Check('subscription_plan_non_negative_money', '"monthlyPriceCents" >= 0 AND "quotaCents" >= 0')
@Check(
  'subscription_plan_positive_overage_multipliers',
  '"overageCpuMultiplier" >= 1 AND "overageMemMultiplier" >= 1 AND "overageDiskMultiplier" >= 1 AND "overageGpuMultiplier" >= 1',
)
export class SubscriptionPlan {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ type: 'character varying' })
  code: SubscriptionPlanCode

  @Column({ type: 'integer' })
  rank: number

  @Column({ type: 'bigint' })
  monthlyPriceCents: string

  @Column({ type: 'bigint' })
  quotaCents: string

  @Column({ type: 'numeric', precision: 20, scale: 9, default: 1 })
  overageCpuMultiplier: string

  @Column({ type: 'numeric', precision: 20, scale: 9, default: 1 })
  overageMemMultiplier: string

  @Column({ type: 'numeric', precision: 20, scale: 9, default: 1 })
  overageDiskMultiplier: string

  @Column({ type: 'numeric', precision: 20, scale: 9, default: 1 })
  overageGpuMultiplier: string

  @Column({ type: 'boolean', default: true })
  active: boolean

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date
}
