/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Check, Column, CreateDateColumn, Entity, Exclusion, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'

@Entity('subscription_period')
@Index('subscription_period_subscription_start_idx', ['subscriptionId', 'periodStart'], { unique: true })
@Index('subscription_period_org_interval_idx', ['organizationId', 'periodStart', 'periodEnd'])
@Check('subscription_period_valid_interval', '"periodEnd" > "periodStart"')
@Check(
  'subscription_period_valid_quota',
  '"quotaGrantedPreciseCents" >= 0 AND "quotaConsumedPreciseCents" >= 0 AND "quotaConsumedPreciseCents" <= "quotaGrantedPreciseCents"',
)
@Exclusion(
  'subscription_period_org_no_overlap',
  `USING gist ("organizationId" WITH =, (tstzrange("periodStart", "periodEnd", '[)')) WITH &&)`,
)
export class SubscriptionPeriod {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ type: 'uuid' })
  subscriptionId: string

  @Column({ type: 'uuid' })
  organizationId: string

  @Column({ type: 'timestamp with time zone' })
  periodStart: Date

  @Column({ type: 'timestamp with time zone' })
  periodEnd: Date

  @Column({ type: 'numeric', precision: 38, scale: 18 })
  quotaGrantedPreciseCents: string

  @Column({ type: 'numeric', precision: 38, scale: 18, default: 0 })
  quotaConsumedPreciseCents: string

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date
}
