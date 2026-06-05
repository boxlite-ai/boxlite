/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'
import { RunnerArtifactCacheState } from '../enums/runner-artifact-cache-state.enum'

@Entity()
@Index('runner_artifact_cache_artifactref_idx', ['artifactRef'])
@Index('runner_artifact_cache_runnerid_artifactref_idx', ['runnerId', 'artifactRef'])
@Index('runner_artifact_cache_runnerid_idx', ['runnerId'])
@Index('runner_artifact_cache_state_idx', ['state'])
export class RunnerArtifactCache {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({
    type: 'enum',
    enum: RunnerArtifactCacheState,
    default: RunnerArtifactCacheState.PULLING_ARTIFACT,
  })
  state: RunnerArtifactCacheState

  @Column({ nullable: true })
  errorReason?: string

  @Column({
    //  todo: remove default
    default: '',
  })
  artifactRef: string

  @Column()
  runnerId: string

  @CreateDateColumn({
    type: 'timestamp with time zone',
  })
  createdAt: Date

  @UpdateDateColumn({
    type: 'timestamp with time zone',
  })
  updatedAt: Date
}
