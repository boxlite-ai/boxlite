/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import { OnEvent } from '@nestjs/event-emitter'
import { NotificationEmitter } from '../gateways/notification-emitter.abstract'
import { BoxEvents } from '../../box/constants/box-events.constants'
import { BoxCreatedEvent } from '../../box/events/box-create.event'
import { BoxStateUpdatedEvent } from '../../box/events/box-state-updated.event'
import { VolumeEvents } from '../../box/constants/volume-events'
import { VolumeCreatedEvent } from '../../box/events/volume-created.event'
import { VolumeDto } from '../../box/dto/volume.dto'
import { VolumeStateUpdatedEvent } from '../../box/events/volume-state-updated.event'
import { VolumeLastUsedAtUpdatedEvent } from '../../box/events/volume-last-used-at-updated.event'
import { BoxDesiredStateUpdatedEvent } from '../../box/events/box-desired-state-updated.event'
import { RunnerEvents } from '../../box/constants/runner-events'
import { RunnerDto } from '../../box/dto/runner.dto'
import { RunnerCreatedEvent } from '../../box/events/runner-created.event'
import { RunnerStateUpdatedEvent } from '../../box/events/runner-state-updated.event'
import { RunnerUnschedulableUpdatedEvent } from '../../box/events/runner-unschedulable-updated.event'
import { RegionService } from '../../region/services/region.service'
import { BoxService } from '../../box/services/box.service'
import { InjectRedis } from '@nestjs-modules/ioredis'
import { Redis } from 'ioredis'
import { BOX_EVENT_CHANNEL } from '../../common/constants/constants'

@Injectable()
export class NotificationService {
  constructor(
    private readonly notificationEmitter: NotificationEmitter,
    private readonly regionService: RegionService,
    private readonly boxService: BoxService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  @OnEvent(BoxEvents.CREATED)
  async handleBoxCreated(event: BoxCreatedEvent) {
    const dto = await this.boxService.toBoxDto(event.box)
    this.notificationEmitter.emitBoxCreated(dto)
  }

  @OnEvent(BoxEvents.STATE_UPDATED)
  async handleBoxStateUpdated(event: BoxStateUpdatedEvent) {
    const dto = await this.boxService.toBoxDto(event.box)
    this.notificationEmitter.emitBoxStateUpdated(dto, event.oldState, event.newState)
    this.redis.publish(BOX_EVENT_CHANNEL, JSON.stringify(event))
  }

  @OnEvent(BoxEvents.DESIRED_STATE_UPDATED)
  async handleBoxDesiredStateUpdated(event: BoxDesiredStateUpdatedEvent) {
    const dto = await this.boxService.toBoxDto(event.box)
    this.notificationEmitter.emitBoxDesiredStateUpdated(dto, event.oldDesiredState, event.newDesiredState)
    this.redis.publish(BOX_EVENT_CHANNEL, JSON.stringify(event))
  }

  @OnEvent(VolumeEvents.CREATED)
  async handleVolumeCreated(event: VolumeCreatedEvent) {
    const dto = VolumeDto.fromVolume(event.volume)
    this.notificationEmitter.emitVolumeCreated(dto)
  }

  @OnEvent(VolumeEvents.STATE_UPDATED)
  async handleVolumeStateUpdated(event: VolumeStateUpdatedEvent) {
    const dto = VolumeDto.fromVolume(event.volume)
    this.notificationEmitter.emitVolumeStateUpdated(dto, event.oldState, event.newState)
  }

  @OnEvent(VolumeEvents.LAST_USED_AT_UPDATED)
  async handleVolumeLastUsedAtUpdated(event: VolumeLastUsedAtUpdatedEvent) {
    const dto = VolumeDto.fromVolume(event.volume)
    this.notificationEmitter.emitVolumeLastUsedAtUpdated(dto)
  }

  @OnEvent(RunnerEvents.CREATED)
  async handleRunnerCreated(event: RunnerCreatedEvent) {
    const dto = RunnerDto.fromRunner(event.runner)
    const organizationId = await this.regionService.getOrganizationId(event.runner.region)
    if (organizationId !== undefined) {
      this.notificationEmitter.emitRunnerCreated(dto, organizationId)
    }
  }

  @OnEvent(RunnerEvents.STATE_UPDATED)
  async handleRunnerStateUpdated(event: RunnerStateUpdatedEvent) {
    const dto = RunnerDto.fromRunner(event.runner)
    const organizationId = await this.regionService.getOrganizationId(event.runner.region)
    if (organizationId !== undefined) {
      this.notificationEmitter.emitRunnerStateUpdated(dto, organizationId, event.oldState, event.newState)
    }
  }

  @OnEvent(RunnerEvents.UNSCHEDULABLE_UPDATED)
  async handleRunnerUnschedulableUpdated(event: RunnerUnschedulableUpdatedEvent) {
    const dto = RunnerDto.fromRunner(event.runner)
    const organizationId = await this.regionService.getOrganizationId(event.runner.region)
    if (organizationId !== undefined) {
      this.notificationEmitter.emitRunnerUnschedulableUpdated(dto, organizationId)
    }
  }
}
