/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  OneToOne,
  Unique,
  UpdateDateColumn,
} from 'typeorm'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxClass } from '../enums/box-class.enum'
import { BackupState } from '../enums/backup-state.enum'
import { v4 as uuidv4 } from 'uuid'
import { BoxVolume } from '../dto/box.dto'
import { BuildInfo } from './build-info.entity'
import { nanoid } from 'nanoid'
import { BoxLastActivity } from './box-last-activity.entity'

@Entity('box')
@Unique(['organizationId', 'name'])
@Index('box_state_idx', ['state'])
@Index('box_desiredstate_idx', ['desiredState'])
@Index('box_snapshot_idx', ['snapshot'])
@Index('box_runnerid_idx', ['runnerId'])
@Index('box_runner_state_idx', ['runnerId', 'state'])
@Index('box_organizationid_idx', ['organizationId'])
@Index('box_region_idx', ['region'])
@Index('box_resources_idx', ['cpu', 'mem', 'disk', 'gpu'])
@Index('box_backupstate_idx', ['backupState'])
@Index('box_runner_state_desired_idx', ['runnerId', 'state', 'desiredState'], {
  where: '"pending" = false',
})
@Index('box_active_only_idx', ['id'], {
  where: `"state" <> ALL (ARRAY['destroyed'::box_state_enum, 'archived'::box_state_enum])`,
})
@Index('box_pending_idx', ['id'], {
  where: `"pending" = true`,
})
@Index('idx_box_authtoken', ['authToken'])
@Index('box_labels_gin_full_idx', { synchronize: false })
@Index('idx_box_volumes_gin', { synchronize: false })
export class Box {
  @PrimaryColumn({ default: () => 'uuid_generate_v4()' })
  id: string

  @Column({
    type: 'uuid',
  })
  organizationId: string

  @Column()
  name: string

  @Column()
  region: string

  @Column({
    type: 'uuid',
    nullable: true,
  })
  runnerId?: string

  //  this is the runnerId of the runner that was previously assigned to the box
  //  if something goes wrong with new runner assignment, we can revert to the previous runner
  @Column({
    type: 'uuid',
    nullable: true,
  })
  prevRunnerId?: string

  @Column({
    type: 'enum',
    enum: BoxClass,
    default: BoxClass.SMALL,
  })
  class = BoxClass.SMALL

  @Column({
    type: 'enum',
    enum: BoxState,
    default: BoxState.UNKNOWN,
  })
  state = BoxState.UNKNOWN

  @Column({
    type: 'enum',
    enum: BoxDesiredState,
    default: BoxDesiredState.STARTED,
  })
  desiredState = BoxDesiredState.STARTED

  @Column({ nullable: true })
  snapshot?: string

  @Column()
  osUser: string

  @Column({ nullable: true })
  errorReason?: string

  @Column({ default: false, type: 'boolean' })
  recoverable = false

  @Column({
    type: 'jsonb',
    default: {},
  })
  env: { [key: string]: string } = {}

  @Column({ default: false, type: 'boolean' })
  public = false

  @Column({ default: false, type: 'boolean' })
  networkBlockAll = false

  @Column({ nullable: true })
  networkAllowList?: string

  @Column('jsonb', { nullable: true })
  labels: { [key: string]: string }

  @Column({ nullable: true })
  backupRegistryId: string | null

  @Column({ nullable: true })
  backupSnapshot: string | null

  @Column({ nullable: true, type: 'timestamp with time zone' })
  lastBackupAt: Date | null

  @Column({
    type: 'enum',
    enum: BackupState,
    default: BackupState.NONE,
  })
  backupState = BackupState.NONE

  @Column({
    type: 'text',
    nullable: true,
  })
  backupErrorReason: string | null

  @Column({
    type: 'jsonb',
    default: [],
  })
  existingBackupSnapshots: Array<{
    snapshotName: string
    createdAt: Date
  }> = []

  @Column({ type: 'int', default: 2 })
  cpu = 2

  @Column({ type: 'int', default: 0 })
  gpu = 0

  @Column({ type: 'int', default: 4 })
  mem = 4

  @Column({ type: 'int', default: 10 })
  disk = 10

  @Column({
    type: 'jsonb',
    default: [],
  })
  volumes: BoxVolume[] = []

  @CreateDateColumn({
    type: 'timestamp with time zone',
  })
  createdAt: Date

  @UpdateDateColumn({
    type: 'timestamp with time zone',
  })
  updatedAt: Date

  @OneToOne(() => BoxLastActivity, (lastActivity) => lastActivity.box)
  lastActivityAt?: BoxLastActivity

  //  this is the interval in minutes after which the box will be stopped if lastActivityAt is not updated
  //  if set to 0, auto stop will be disabled
  @Column({ default: 15, type: 'int' })
  autoStopInterval: number | undefined = 15

  //  this is the interval in minutes after which a continuously stopped workspace will be automatically archived
  @Column({ default: 7 * 24 * 60, type: 'int' })
  autoArchiveInterval: number | undefined = 7 * 24 * 60

  //  this is the interval in minutes after which a continuously stopped workspace will be automatically deleted
  //  if set to negative value, auto delete will be disabled
  //  if set to 0, box will be immediately deleted upon stopping
  @Column({ default: -1, type: 'int' })
  autoDeleteInterval: number | undefined = -1

  @Column({ default: false, type: 'boolean' })
  pending: boolean | undefined = false

  @Column({ type: 'character varying' })
  authToken = nanoid(32).toLowerCase()

  @ManyToOne(() => BuildInfo, (buildInfo) => buildInfo.boxes, {
    nullable: true,
  })
  @JoinColumn()
  buildInfo?: BuildInfo

  @Column({ nullable: true })
  daemonVersion?: string

  constructor(region: string, name?: string) {
    this.id = uuidv4()
    // Set name - use provided name or fallback to ID
    this.name = name || this.id
    this.region = region
  }

  /**
   * Helper method that returns the update data needed for a backup state update.
   */
  static getBackupStateUpdate(
    box: Box,
    backupState: BackupState,
    backupSnapshot?: string | null,
    backupRegistryId?: string | null,
    backupErrorReason?: string | null,
  ): Partial<Box> {
    const update: Partial<Box> = {
      backupState,
    }
    switch (backupState) {
      case BackupState.NONE:
        update.backupSnapshot = null
        break
      case BackupState.COMPLETED: {
        const now = new Date()
        update.lastBackupAt = now
        if (box.backupSnapshot) {
          update.existingBackupSnapshots = [
            ...box.existingBackupSnapshots,
            {
              snapshotName: box.backupSnapshot,
              createdAt: now,
            },
          ]
        }
        update.backupErrorReason = null
        break
      }
    }
    if (backupSnapshot !== undefined) {
      update.backupSnapshot = backupSnapshot
    }
    if (backupRegistryId !== undefined) {
      update.backupRegistryId = backupRegistryId
    }
    if (backupErrorReason !== undefined) {
      update.backupErrorReason = backupErrorReason
    }
    return update
  }

  /**
   * Helper method that returns the update data needed for a soft delete operation.
   */
  static getSoftDeleteUpdate(box: Box): Partial<Box> {
    return {
      pending: true,
      desiredState: BoxDesiredState.DESTROYED,
      backupState: BackupState.NONE,
      name: 'DESTROYED_' + box.name + '_' + Date.now(),
    }
  }

  /**
   * Asserts that the current entity state is valid.
   */
  assertValid(): void {
    this.validateDesiredStateTransition()
  }

  private validateDesiredStateTransition(): void {
    switch (this.desiredState) {
      case BoxDesiredState.STARTED:
        if (
          [
            BoxState.STARTED,
            BoxState.STOPPED,
            BoxState.STARTING,
            BoxState.ARCHIVED,
            BoxState.CREATING,
            BoxState.UNKNOWN,
            BoxState.RESTORING,
            BoxState.PENDING_BUILD,
            BoxState.BUILDING_SNAPSHOT,
            BoxState.PULLING_SNAPSHOT,
            BoxState.ARCHIVING,
            BoxState.ERROR,
            BoxState.BUILD_FAILED,
            BoxState.RESIZING,
          ].includes(this.state)
        ) {
          break
        }
        throw new Error(`Box ${this.id} is not in a valid state to be started. State: ${this.state}`)
      case BoxDesiredState.STOPPED:
        if (
          [
            BoxState.STARTED,
            BoxState.STOPPING,
            BoxState.STOPPED,
            BoxState.ERROR,
            BoxState.BUILD_FAILED,
            BoxState.RESIZING,
          ].includes(this.state)
        ) {
          break
        }
        throw new Error(`Box ${this.id} is not in a valid state to be stopped. State: ${this.state}`)
      case BoxDesiredState.ARCHIVED:
        if (
          [BoxState.ARCHIVED, BoxState.ARCHIVING, BoxState.STOPPED, BoxState.ERROR, BoxState.BUILD_FAILED].includes(
            this.state,
          )
        ) {
          break
        }
        throw new Error(`Box ${this.id} is not in a valid state to be archived. State: ${this.state}`)
      case BoxDesiredState.DESTROYED:
        if (
          [
            BoxState.DESTROYED,
            BoxState.DESTROYING,
            BoxState.STOPPED,
            BoxState.STARTED,
            BoxState.ARCHIVED,
            BoxState.ERROR,
            BoxState.BUILD_FAILED,
            BoxState.ARCHIVING,
            BoxState.PENDING_BUILD,
          ].includes(this.state)
        ) {
          break
        }
        throw new Error(`Box ${this.id} is not in a valid state to be destroyed. State: ${this.state}`)
    }
  }

  /**
   * Enforces domain invariants on the current entity state.
   *
   * @returns Additional field changes that invariant enforcement produced.
   */
  enforceInvariants(): Partial<Box> {
    const changes = this.getInvariantChanges()
    Object.assign(this, changes)
    return changes
  }

  private getInvariantChanges(): Partial<Box> {
    const changes: Partial<Box> = {}

    if (!this.pending && String(this.state) !== String(this.desiredState)) {
      changes.pending = true
    }
    if (this.pending && String(this.state) === String(this.desiredState)) {
      changes.pending = false
    }
    if (
      this.state === BoxState.ERROR ||
      this.state === BoxState.BUILD_FAILED ||
      this.desiredState === BoxDesiredState.ARCHIVED
    ) {
      changes.pending = false
    }

    if (this.state === BoxState.DESTROYED || this.state === BoxState.ARCHIVED) {
      changes.runnerId = null
    }

    if (this.state === BoxState.DESTROYED) {
      changes.backupState = BackupState.NONE
    }

    return changes
  }
}
