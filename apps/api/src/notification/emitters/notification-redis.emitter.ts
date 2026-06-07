/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { Emitter } from '@socket.io/redis-emitter'
import { InjectRedis } from '@nestjs-modules/ioredis'
import Redis from 'ioredis'
import { NotificationEmitter } from '../gateways/notification-emitter.abstract'
import { SandboxDto } from '../../sandbox/dto/sandbox.dto'
import { SandboxState } from '../../sandbox/enums/sandbox-state.enum'
import { SandboxDesiredState } from '../../sandbox/enums/sandbox-desired-state.enum'
import { SandboxEvents } from '../../sandbox/constants/sandbox-events.constants'
import { SavedImageDto } from '../../sandbox/dto/saved-image.dto'
import { SavedImageState } from '../../sandbox/enums/saved-image-state.enum'
import { SavedImageEvents } from '../../sandbox/constants/saved-image-events'
import { VolumeDto } from '../../sandbox/dto/volume.dto'
import { VolumeState } from '../../sandbox/enums/volume-state.enum'
import { VolumeEvents } from '../../sandbox/constants/volume-events'
import { RunnerDto } from '../../sandbox/dto/runner.dto'
import { RunnerState } from '../../sandbox/enums/runner-state.enum'
import { RunnerEvents } from '../../sandbox/constants/runner-events'

@Injectable()
export class NotificationRedisEmitter extends NotificationEmitter implements OnModuleInit {
  private readonly logger = new Logger(NotificationRedisEmitter.name)
  private emitter: Emitter

  constructor(@InjectRedis() private readonly redis: Redis) {
    super()
  }

  onModuleInit() {
    this.emitter = new Emitter(this.redis.duplicate())
    this.logger.debug('Socket.io Redis emitter initialized (publish-only)')
  }

  emitSandboxCreated(sandbox: SandboxDto) {
    this.emitter.to(sandbox.organizationId).emit(SandboxEvents.CREATED, sandbox)
  }

  emitSandboxStateUpdated(sandbox: SandboxDto, oldState: SandboxState, newState: SandboxState) {
    this.emitter.to(sandbox.organizationId).emit(SandboxEvents.STATE_UPDATED, { sandbox, oldState, newState })
  }

  emitSandboxDesiredStateUpdated(
    sandbox: SandboxDto,
    oldDesiredState: SandboxDesiredState,
    newDesiredState: SandboxDesiredState,
  ) {
    this.emitter
      .to(sandbox.organizationId)
      .emit(SandboxEvents.DESIRED_STATE_UPDATED, { sandbox, oldDesiredState, newDesiredState })
  }

  emitSavedImageCreated(savedImage: SavedImageDto) {
    this.emitter.to(savedImage.organizationId).emit(SavedImageEvents.CREATED, savedImage)
  }

  emitSavedImageStateUpdated(savedImage: SavedImageDto, oldState: SavedImageState, newState: SavedImageState) {
    this.emitter.to(savedImage.organizationId).emit(SavedImageEvents.STATE_UPDATED, { savedImage, oldState, newState })
  }

  emitSavedImageRemoved(savedImage: SavedImageDto) {
    this.emitter.to(savedImage.organizationId).emit(SavedImageEvents.REMOVED, savedImage)
  }

  emitVolumeCreated(volume: VolumeDto) {
    this.emitter.to(volume.organizationId).emit(VolumeEvents.CREATED, volume)
  }

  emitVolumeStateUpdated(volume: VolumeDto, oldState: VolumeState, newState: VolumeState) {
    this.emitter.to(volume.organizationId).emit(VolumeEvents.STATE_UPDATED, { volume, oldState, newState })
  }

  emitVolumeLastUsedAtUpdated(volume: VolumeDto) {
    this.emitter.to(volume.organizationId).emit(VolumeEvents.LAST_USED_AT_UPDATED, volume)
  }

  emitRunnerCreated(runner: RunnerDto, organizationId: string | null) {
    if (!organizationId) {
      return
    }
    this.emitter.to(organizationId).emit(RunnerEvents.CREATED, runner)
  }

  emitRunnerStateUpdated(
    runner: RunnerDto,
    organizationId: string | null,
    oldState: RunnerState,
    newState: RunnerState,
  ) {
    if (!organizationId) {
      return
    }
    this.emitter.to(organizationId).emit(RunnerEvents.STATE_UPDATED, { runner, oldState, newState })
  }

  emitRunnerUnschedulableUpdated(runner: RunnerDto, organizationId: string | null) {
    if (!organizationId) {
      return
    }
    this.emitter.to(organizationId).emit(RunnerEvents.UNSCHEDULABLE_UPDATED, runner)
  }
}
