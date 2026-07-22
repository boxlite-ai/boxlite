/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Check, Column, CreateDateColumn, Entity, Exclusion, Index, PrimaryGeneratedColumn } from 'typeorm'

@Entity('user_resource_multiplier')
@Index('user_resource_multiplier_effective_idx', ['organizationId', 'userId', 'effectiveFrom'])
@Index('user_resource_multiplier_current_idx', ['organizationId', 'userId'], {
  unique: true,
  where: '"effectiveTo" IS NULL',
})
@Check('user_resource_multiplier_valid_interval', '"effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom"')
@Check(
  'user_resource_multiplier_non_negative',
  '"cpuMultiplier" >= 0 AND "memMultiplier" >= 0 AND "diskMultiplier" >= 0 AND "gpuMultiplier" >= 0',
)
@Exclusion(
  'user_resource_multiplier_no_overlap',
  `USING gist ("organizationId" WITH =, "userId" WITH =, (tstzrange("effectiveFrom", COALESCE("effectiveTo", 'infinity'::timestamptz), '[)')) WITH &&)`,
)
export class UserResourceMultiplier {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ type: 'uuid' })
  organizationId: string

  @Column({ type: 'character varying' })
  userId: string

  @Column({ type: 'numeric', precision: 20, scale: 9, default: 1 })
  cpuMultiplier: string

  @Column({ type: 'numeric', precision: 20, scale: 9, default: 1 })
  memMultiplier: string

  @Column({ type: 'numeric', precision: 20, scale: 9, default: 1 })
  diskMultiplier: string

  @Column({ type: 'numeric', precision: 20, scale: 9, default: 1 })
  gpuMultiplier: string

  @Column({ type: 'timestamp with time zone' })
  effectiveFrom: Date

  @Column({ type: 'timestamp with time zone', nullable: true })
  effectiveTo: Date | null

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date
}
