// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

import { Check, Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm'
import { Box } from './box.entity'
import { BoxState } from '../enums/box-state.enum'

export type CheckpointState = 'creating' | 'ready' | 'failed' | 'deleting'
export type CheckpointEnvironment = Pick<
  Box,
  | 'image'
  | 'imageIsOrgOwned'
  | 'region'
  | 'class'
  | 'cpu'
  | 'mem'
  | 'memoryMib'
  | 'disk'
  | 'gpu'
  | 'osUser'
  | 'runAsUser'
  | 'privileged'
  | 'workingDir'
  | 'entrypoint'
  | 'cmd'
  | 'env'
  | 'labels'
  | 'inboundEnabled'
  | 'outboundEnabled'
  | 'outboundAllowNet'
  | 'autoStop'
  | 'autoDelete'
  | 'autoResume'
>

/** Mirrors runner/pkg/checkpoint.Artifact; immutable once an export is accepted. */
export interface CheckpointArchive {
  checkpointId: string
  exportJobId: string
  sourceBoxId: string
  arcPath: string
  sizeBytes: number
  sha256: string
  pinnedImage: string
}

@Entity('checkpoint')
@Check('checkpoint_state_check', `"state" IN ('creating','ready','failed','deleting')`)
@Index('checkpoint_org_name_key', ['organizationId', 'name'], { unique: true })
@Index('checkpoint_active_job_key', ['activeJobId'], { unique: true, where: '"activeJobId" IS NOT NULL' })
export class Checkpoint {
  @PrimaryColumn('uuid') id: string
  @Column('uuid') organizationId: string
  @Column() name: string
  // Historical source identity, deliberately without a source box foreign key.
  @Column() sourceBoxId: string
  @Column('uuid') sourceRunnerId: string
  @Column('varchar') sourceState: BoxState
  @Column({ type: 'varchar', default: 'creating' }) state: CheckpointState
  @Column() arcPath: string
  @Column({ type: 'uuid', nullable: true }) exportJobId: string | null
  @Column({ type: 'uuid', nullable: true }) activeJobId: string | null
  @Column('jsonb') environment: CheckpointEnvironment
  @Column({ type: 'jsonb', nullable: true }) archive: CheckpointArchive | null
  @Column({ type: 'text', nullable: true }) errorReason: string | null
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date
}
