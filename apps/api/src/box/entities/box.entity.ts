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
import {
  AUTO_DELETE_DISABLED,
  DEFAULT_AUTO_PAUSE_SECONDS,
  DEFAULT_AUTO_RESUME,
} from '../constants/box-lifecycle.constants'

/**
 * Box 主进程的启动配置。
 *
 * 远程前台运行不能只依赖创建请求中的临时参数：API 或 Runner 重启后，
 * 控制面仍需使用这些字段恢复“创建、附加、再启动”的完整流程。
 */
export interface BoxLaunchConfig {
  /** 覆盖镜像默认入口程序。 */
  entrypoint?: string[]
  /** 传给入口程序的命令及参数。 */
  cmd?: string[]
  /** 主进程启动时使用的工作目录。 */
  workingDir?: string
  /** 是否为主进程分配终端。 */
  tty?: boolean
  /** 客户端是否要求与主进程分离。 */
  detach?: boolean
  /** 是否使用先附加输出流、再启动主进程的前台流程。 */
  foreground?: boolean
  /** 前台主进程退出后是否删除 Box，用于实现远程 `run --rm`。 */
  autoDeleteAfterExit?: boolean
}

@Entity('box')
@Unique(['organizationId', 'name'])
@Index('box_state_idx', ['state'])
@Index('box_desiredstate_idx', ['desiredState'])
@Index('box_runnerid_idx', ['runnerId'])
@Index('box_runner_state_idx', ['runnerId', 'state'])
@Index('box_organizationid_idx', ['organizationId'])
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

  @Column({
    type: 'jsonb',
    nullable: true,
  })
  // 与 Box 一起持久化，保证控制面重启后仍能恢复前台启动语义。
  launchConfig?: BoxLaunchConfig

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

  @Column({ default: DEFAULT_AUTO_PAUSE_SECONDS, type: 'int' })
  autoPause: number = DEFAULT_AUTO_PAUSE_SECONDS

  @Column({ default: AUTO_DELETE_DISABLED, type: 'int' })
  autoDelete: number = AUTO_DELETE_DISABLED

  @Column({ default: DEFAULT_AUTO_RESUME, type: 'boolean' })
  autoResume: boolean = DEFAULT_AUTO_RESUME

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
