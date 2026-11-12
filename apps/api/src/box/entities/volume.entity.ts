/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm'
import { VolumeState } from '../enums/volume-state.enum'

export type VolumeTargetType = 'box' | 'app'
export interface AppVolumeTarget {
  appId: string
  environmentId: string
}

@Entity()
@Unique(['organizationId', 'name'])
@Index('volume_app_environment_idx', ['appId', 'environmentId'], { where: '"target_type" = \'app\'' })
@Check(
  'volume_target',
  `
  ("target_type" = 'box' AND "app_id" IS NULL AND "environment_id" IS NULL)
  OR ("target_type" = 'app' AND "app_id" IS NOT NULL AND "environment_id" IS NOT NULL
    AND "app_id" ~ '[^[:space:]]' AND "environment_id" ~ '[^[:space:]]')
`,
)
export class Volume {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({
    nullable: true,
    type: 'uuid',
  })
  organizationId?: string

  @Column()
  name: string

  @Column({ name: 'target_type', type: 'character varying', default: 'box' })
  targetType: VolumeTargetType = 'box'

  @Column({ name: 'app_id', type: 'text', nullable: true })
  appId: string | null = null

  @Column({ name: 'environment_id', type: 'text', nullable: true })
  environmentId: string | null = null

  @Column({
    type: 'enum',
    enum: VolumeState,
    default: VolumeState.PENDING_CREATE,
  })
  state: VolumeState

  @Column({ nullable: true })
  errorReason?: string

  @CreateDateColumn({
    type: 'timestamp with time zone',
  })
  createdAt: Date

  @UpdateDateColumn({
    type: 'timestamp with time zone',
  })
  updatedAt: Date

  @Column({ nullable: true })
  lastUsedAt?: Date

  public getBucketName(): string {
    return `boxlite-volume-${this.id}`
  }
}
