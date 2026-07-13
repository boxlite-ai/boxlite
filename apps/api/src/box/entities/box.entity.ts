/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, OneToOne, Unique, UpdateDateColumn } from 'typeorm'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxClass } from '../enums/box-class.enum'
import { BoxVolume } from '../dto/box.dto'
import { nanoid } from 'nanoid'
import { BoxLastActivity } from './box-last-activity.entity'
import { BOX_ID_LENGTH, BOX_ID_REGEX, generateBoxId } from '../utils/box-id.util'

@Entity('box')
@Unique(['organizationId', 'name'])
@Index('box_state_idx', ['state'])
@Index('box_desiredstate_idx', ['desiredState'])
@Index('box_runnerid_idx', ['runnerId'])
@Index('box_runner_state_idx', ['runnerId', 'state'])
@Index('box_organizationid_idx', ['organizationId'])
@Index('box_billing_active_org_idx', ['organizationId'], { where: '"desiredState" = \'started\'' })
@Index('box_region_idx', ['region'])
@Index('box_resources_idx', ['cpu', 'mem', 'disk', 'gpu'])
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
@Index('box_image_idx', ['image'])
@Index('box_labels_gin_full_idx', { synchronize: false })
@Index('idx_box_volumes_gin', { synchronize: false })
export class Box {
  @PrimaryColumn({ type: 'character varying', length: BOX_ID_LENGTH })
  id: string

  @Column({
    type: 'uuid',
  })
  organizationId: string

  @Column()
  name: string

  @Column()
  region: string

  @Column({ nullable: true })
  image?: string

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

  //  this is the interval in minutes after which a continuously stopped workspace will be automatically deleted
  //  if set to negative value, auto delete will be disabled
  //  if set to 0, box will be immediately deleted upon stopping
  @Column({ default: -1, type: 'int' })
  autoDeleteInterval: number | undefined = -1

  @Column({ default: false, type: 'boolean' })
  pending: boolean | undefined = false

  @Column({ type: 'character varying' })
  authToken = nanoid(32).toLowerCase()

  @Column({ nullable: true })
  daemonVersion?: string

  constructor(region: string, name?: string) {
    this.id = generateBoxId()
    // Set name - use provided name or fallback to ID
    this.name = name || this.id
    this.region = region
  }

  /**
   * Helper method that returns the update data needed for a soft delete operation.
   */
  static getSoftDeleteUpdate(box: Box): Partial<Box> {
    return {
      pending: true,
      desiredState: BoxDesiredState.DESTROYED,
      name: 'DESTROYED_' + box.name + '_' + Date.now(),
    }
  }

  /**
   * Asserts that the current entity state is valid.
   */
  assertValid(): void {
    this.validateBoxId()
    this.validateDesiredStateTransition()
  }

  private validateBoxId(): void {
    if (!BOX_ID_REGEX.test(this.id)) {
      throw new Error(`Box has invalid id ${this.id}`)
    }
  }

  private validateDesiredStateTransition(): void {
    switch (this.desiredState) {
      case BoxDesiredState.STARTED:
        if (
          [
            BoxState.STARTED,
            BoxState.STOPPED,
            BoxState.STARTING,
            BoxState.CREATING,
            BoxState.UNKNOWN,
            BoxState.RESTORING,
            BoxState.ERROR,
            BoxState.RESIZING,
          ].includes(this.state)
        ) {
          break
        }
        throw new Error(`Box ${this.id} is not in a valid state to be started. State: ${this.state}`)
      case BoxDesiredState.STOPPED:
        if (
          [BoxState.STARTED, BoxState.STOPPING, BoxState.STOPPED, BoxState.ERROR, BoxState.RESIZING].includes(
            this.state,
          )
        ) {
          break
        }
        throw new Error(`Box ${this.id} is not in a valid state to be stopped. State: ${this.state}`)
      case BoxDesiredState.DESTROYED:
        if (
          [
            BoxState.DESTROYED,
            BoxState.DESTROYING,
            BoxState.STOPPED,
            BoxState.STARTED,
            BoxState.ARCHIVED,
            BoxState.ERROR,
            BoxState.ARCHIVING,
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
    if (this.state === BoxState.ERROR) {
      changes.pending = false
    }

    if (this.state === BoxState.DESTROYED || this.state === BoxState.ARCHIVED) {
      changes.runnerId = null
    }

    return changes
  }
}
