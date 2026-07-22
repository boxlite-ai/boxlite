/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'
import type { OrganizationSubscriptionStatus, SubscriptionChangeKind } from '../subscription/subscription.types'

@Entity('organization_subscription')
@Index('organization_subscription_org_idx', ['organizationId'], { unique: true })
@Index('organization_subscription_provider_idx', ['providerSubscriptionId'], {
  unique: true,
  where: '"providerSubscriptionId" IS NOT NULL',
})
export class OrganizationSubscription {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ type: 'uuid' })
  organizationId: string

  @Column({ type: 'uuid' })
  planId: string

  @Column({ type: 'character varying', default: 'pending' })
  status: OrganizationSubscriptionStatus

  @Column({ type: 'character varying', nullable: true })
  providerSubscriptionId: string | null

  @Column({ type: 'character varying', nullable: true })
  providerScheduleId: string | null

  @Column({ type: 'timestamp with time zone', nullable: true })
  currentPeriodStart: Date | null

  @Column({ type: 'timestamp with time zone', nullable: true })
  currentPeriodEnd: Date | null

  @Column({ type: 'uuid', nullable: true })
  pendingPlanId: string | null

  @Column({ type: 'character varying', nullable: true })
  pendingChangeKind: SubscriptionChangeKind | null

  @Column({ type: 'character varying', nullable: true })
  pendingChangeIdempotencyKey: string | null

  @Column({ type: 'timestamp with time zone', nullable: true })
  pendingPlanEffectiveAt: Date | null

  @Column({ type: 'character varying', nullable: true })
  checkoutProviderReference: string | null

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date
}
