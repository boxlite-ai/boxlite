/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { Emitter } from '@socket.io/redis-emitter'
import { InjectRedis } from '@nestjs-modules/ioredis'
import Redis from 'ioredis'
import { NotificationEmitter } from '../gateways/notification-emitter.abstract'
import { BoxDto } from '../../box/dto/box.dto'
import { BoxState } from '../../box/enums/box-state.enum'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { BoxEvents } from '../../box/constants/box-events.constants'
import { VolumeDto } from '../../box/dto/volume.dto'
import { VolumeState } from '../../box/enums/volume-state.enum'
import { VolumeEvents } from '../../box/constants/volume-events'
import { RunnerDto } from '../../box/dto/runner.dto'
import { RunnerState } from '../../box/enums/runner-state.enum'
import { RunnerEvents } from '../../box/constants/runner-events'

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

  emitBoxCreated(box: BoxDto) {
    this.emitter.to(box.organizationId).emit(BoxEvents.CREATED, box)
  }

  emitBoxStateUpdated(box: BoxDto, oldState: BoxState, newState: BoxState) {
    this.emitter.to(box.organizationId).emit(BoxEvents.STATE_UPDATED, { box, oldState, newState })
  }

  emitBoxDesiredStateUpdated(box: BoxDto, oldDesiredState: BoxDesiredState, newDesiredState: BoxDesiredState) {
    this.emitter.to(box.organizationId).emit(BoxEvents.DESIRED_STATE_UPDATED, { box, oldDesiredState, newDesiredState })
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
