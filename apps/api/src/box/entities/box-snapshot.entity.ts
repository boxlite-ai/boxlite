/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'
import { BoxSnapshotState } from '../enums/box-snapshot-state.enum'

/**
 * A box's disk, exported to object storage under the organization's name.
 *
 * The snapshot belongs to the organization, not to the box it came from: it
 * outlives that box and restores into any stopped box of the organization
 * with the same disk size and region. A name is taken by every snapshot not
 * being deleted, a failed one included, so a retry with the same name has to
 * retire the failure first (see BoxSnapshotService.create).
 */
@Entity('box_snapshot')
@Index('box_snapshot_organization_name_unique', ['organizationId', 'name'], {
  unique: true,
  where: `"state" <> 'deleting'`,
})
@Index('box_snapshot_source_box_idx', ['organizationId', 'sourceBoxId'])
@Index('box_snapshot_state_idx', ['state'])
@Index('box_snapshot_job_idx', ['jobId'])
export class BoxSnapshot {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'box_snapshot_id_pk' })
  id: string

  @Column({ type: 'uuid' })
  organizationId: string

  @Column({ type: 'character varying' })
  name: string

  // The box the snapshot was taken from. Not a foreign key: the snapshot
  // outlives the box, whose row is hard-deleted a day after it is destroyed.
  @Column({ type: 'character varying', length: 12 })
  sourceBoxId: string

  @Column({ type: 'character varying' })
  region: string

  // The source box's disk size. A restore replaces the target's disk with this
  // one, so only a box of the same size can take it.
  @Column({ type: 'integer' })
  diskGb: number

  @Column({ type: 'enum', enum: BoxSnapshotState, default: BoxSnapshotState.CREATING })
  state: BoxSnapshotState

  // The object the archive is written to, as a full URI (gs://bucket/key),
  // fixed when the snapshot is created so a later change of the configured
  // prefix strands nothing. Emptied once the reaper has deleted the object.
  @Column({ type: 'character varying', default: '' })
  archiveUri: string

  // The CREATE_SNAPSHOT job that writes the archive.
  @Column({ type: 'uuid', nullable: true })
  jobId: string | null

  // The archive's size in object storage, known once the export finished.
  @Column({
    type: 'bigint',
    default: 0,
    transformer: { to: (value: number) => value, from: (value: string) => Number(value) },
  })
  sizeBytes: number

  @Column({ type: 'text', nullable: true })
  errorReason: string | null

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date
}
