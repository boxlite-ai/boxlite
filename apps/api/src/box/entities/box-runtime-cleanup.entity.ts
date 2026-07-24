/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm'

@Entity('box_runtime_cleanup')
@Unique('box_runtime_cleanup_target_uq', ['boxId', 'runnerId', 'runnerEpoch', 'runtimeGeneration'])
@Index('box_runtime_cleanup_job_idx', ['jobId'], { unique: true, where: '"jobId" IS NOT NULL' })
export class BoxRuntimeCleanup {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ type: 'character varying', length: 12 })
  boxId: string

  @Column({ type: 'uuid' })
  runnerId: string

  @Column({ type: 'uuid' })
  runnerEpoch: string

  @Column({ type: 'bigint', transformer: { to: (value: number) => value, from: (value: string) => Number(value) } })
  runtimeGeneration: number

  @Column({ type: 'uuid', nullable: true })
  jobId: string | null

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date
}
