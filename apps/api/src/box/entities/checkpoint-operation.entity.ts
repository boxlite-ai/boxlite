// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

import { Check, Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm'
import { CheckpointEnvironment } from './checkpoint.entity'

export type CheckpointOperationState = 'pending' | 'failed' | 'completed' | 'cancelled'

/** Owns a checkpoint use independently of individual runner job attempts. */
@Entity('checkpoint_operation')
@Check('checkpoint_operation_state_check', `"state" IN ('pending','failed','completed','cancelled')`)
@Index('checkpoint_operation_job_key', ['jobId'], { unique: true })
@Index('checkpoint_operation_target_sequence_key', ['boxId', 'sequence'], { unique: true })
@Index('checkpoint_operation_use_idx', ['checkpointId', 'state'])
export class CheckpointOperation {
  @PrimaryColumn('uuid') id: string
  @Column('uuid') organizationId: string
  @Column('uuid') checkpointId: string
  @Column() boxId: string
  @Column('uuid') runnerId: string
  @Column('int') sequence: number
  @Column() mode: 'create' | 'recover'
  @Column({ type: 'varchar', default: 'pending' }) state: CheckpointOperationState
  @Column('uuid') jobId: string
  // Until completion, this is a reservation; the public Box keeps its committed settings.
  @Column('jsonb') environment: CheckpointEnvironment
  @Column('jsonb') platformEnv: Record<string, string>
  @Column({ type: 'varchar', nullable: true }) nativeId: string | null
  @Column({ type: 'text', nullable: true }) errorReason: string | null
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date
}
