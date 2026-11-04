/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0 */

import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm'

export type CheckpointState = 'creating' | 'ready' | 'failed' | 'deleting'

/** Only native-inspected or control-plane-owned configuration is persisted here. */
export interface CheckpointConfiguration {
  image: string
  env: [string, string][]
  working_dir?: string | null
  user?: string | null
  entrypoint?: string[] | null
  cmd?: string[] | null
  tty: boolean
  privileged: boolean
  outbound: { mode: 'enabled' | 'disabled'; allow_net?: string[] }
  inbound: { mode: 'enabled' | 'disabled' }
}

@Entity('box_checkpoint')
@Index('box_checkpoint_org_name_unique', ['organizationId', 'name'], { unique: true, where: `"state" <> 'deleting'` })
@Index('box_checkpoint_source_idx', ['organizationId', 'sourceBoxId'])
@Index('box_checkpoint_state_idx', ['state'])
export class BoxCheckpoint {
  @PrimaryColumn('uuid') id: string
  @Column('uuid') organizationId: string
  @Column() name: string
  // Deliberately no source FK: a completed checkpoint outlives its source.
  @Column() sourceBoxId: string
  @Column() region: string
  @Column({ default: 'creating' }) state: CheckpointState
  @Column({ default: '' }) archiveUri: string
  @Column({ type: 'boolean', default: true }) visible = true
  @Column({ type: 'uuid', nullable: true }) nativeCheckpointId: string | null
  @Column({ type: 'uuid', nullable: true }) nativeRunnerId: string | null
  @Column({ nullable: true }) bootDiskSha256: string | null
  @Column({ nullable: true }) contentSha256: string | null
  @Column({ type: 'jsonb' }) configuration: CheckpointConfiguration
  @Column('integer') cpus: number
  @Column('integer') memoryMib: number
  @Column('integer') diskGb: number
  @Column({ type: 'bigint', default: 0, transformer: { to: (v: number) => v, from: (v: string) => Number(v) } })
  sizeBytes: number
  @Column({ type: 'text', nullable: true }) errorReason: string | null
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date
}

@Entity('box_checkpoint_operation')
@Index('box_checkpoint_operation_job_unique', ['jobId'], { unique: true })
@Index('box_checkpoint_operation_state_idx', ['state'])
@Index('box_checkpoint_operation_resource_idx', ['checkpointId', 'state'])
export class BoxCheckpointOperation {
  @PrimaryColumn('uuid') id: string
  @Column('uuid') organizationId: string
  @Column() boxId: string
  @Column({ type: 'uuid', nullable: true }) checkpointId: string | null
  @Column('uuid') jobId: string
  @Column() kind: 'pause' | 'resume' | 'capture' | 'restore'
  @Column({ default: 'pending' }) state: 'pending' | 'succeeded' | 'failed'
  @Column({ type: 'jsonb', nullable: true }) error: Record<string, unknown> | null
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date
}

export interface CloudCheckpointInspection {
  version: number
  pair_sha256: string
  boot_disk_sha256: string
  boot_disk_bytes: number
  memory_file_bytes: number
  qcow2_bytes: number
  container_disk_bytes: number
  resources: { cpus: number; memory_mib: number; max_cpus: number; max_memory_mib: number }
  configuration: CheckpointConfiguration
}

@Entity('box_checkpoint_transfer')
@Index('box_checkpoint_transfer_expiry_idx', ['expiresAt'])
export class BoxCheckpointTransfer {
  @PrimaryColumn('uuid') id: string
  @Column('uuid') organizationId: string
  @Column('uuid') runnerId: string
  @Column() kind: 'upload' | 'export'
  @Column({ default: 'staging' }) state: 'staging' | 'registered' | 'consumed' | 'cleanup'
  @Column({ type: 'jsonb', nullable: true }) inspection: CloudCheckpointInspection | null
  @Column({ type: 'uuid', nullable: true }) nativeCheckpointId: string | null
  @Column({ type: 'uuid', nullable: true }) checkpointId: string | null
  @Column({ nullable: true }) targetBoxId: string | null
  @Column({ type: 'timestamptz' }) expiresAt: Date
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date
}
