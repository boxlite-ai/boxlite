/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm'
import { BoxSnapshotRestoreState } from '../enums/box-snapshot-restore-state.enum'
import { Box } from './box.entity'
import { BoxSnapshot } from './box-snapshot.entity'

/**
 * One restore of a snapshot into a box: the record a caller polls, since the
 * box ends up stopped whether the restore succeeded or not.
 *
 * Both references cascade. A restore says nothing once its box is gone, and a
 * snapshot cannot be deleted while a restore of it is still pending.
 */
@Entity('box_snapshot_restore')
@Index('box_snapshot_restore_snapshot_idx', ['snapshotId', 'state'])
@Index('box_snapshot_restore_box_idx', ['boxId'])
@Index('box_snapshot_restore_state_idx', ['state'])
@Index('box_snapshot_restore_job_idx', ['jobId'])
export class BoxSnapshotRestore {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'box_snapshot_restore_id_pk' })
  id: string

  @Column({ type: 'uuid' })
  organizationId: string

  @Column({ type: 'character varying', length: 12 })
  boxId: string

  @Column({ type: 'uuid' })
  snapshotId: string

  @Column({ type: 'enum', enum: BoxSnapshotRestoreState, default: BoxSnapshotRestoreState.PENDING })
  state: BoxSnapshotRestoreState

  // The RESTORE_SNAPSHOT job that replaces the box's disk.
  @Column({ type: 'uuid', nullable: true })
  jobId: string | null

  @Column({ type: 'text', nullable: true })
  errorReason: string | null

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date

  @Column({ type: 'timestamp with time zone', nullable: true })
  completedAt: Date | null

  @ManyToOne(() => Box, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'boxId', foreignKeyConstraintName: 'box_snapshot_restore_box_fk' })
  box?: Box

  @ManyToOne(() => BoxSnapshot, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'snapshotId', foreignKeyConstraintName: 'box_snapshot_restore_snapshot_fk' })
  snapshot?: BoxSnapshot
}
