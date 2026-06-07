/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import { OnEvent } from '@nestjs/event-emitter'
import { NotificationEmitter } from '../gateways/notification-emitter.abstract'
import { SandboxEvents } from '../../sandbox/constants/sandbox-events.constants'
import { SandboxCreatedEvent } from '../../sandbox/events/sandbox-create.event'
import { SandboxStateUpdatedEvent } from '../../sandbox/events/sandbox-state-updated.event'
import { SavedImageCreatedEvent } from '../../sandbox/events/saved-image-created.event'
import { SavedImageEvents } from '../../sandbox/constants/saved-image-events'
import { SavedImageDto } from '../../sandbox/dto/saved-image.dto'
import { SavedImageStateUpdatedEvent } from '../../sandbox/events/saved-image-state-updated.event'
import { SavedImageRemovedEvent } from '../../sandbox/events/saved-image-removed.event'
import { VolumeEvents } from '../../sandbox/constants/volume-events'
import { VolumeCreatedEvent } from '../../sandbox/events/volume-created.event'
import { VolumeDto } from '../../sandbox/dto/volume.dto'
import { VolumeStateUpdatedEvent } from '../../sandbox/events/volume-state-updated.event'
import { VolumeLastUsedAtUpdatedEvent } from '../../sandbox/events/volume-last-used-at-updated.event'
import { SandboxDesiredStateUpdatedEvent } from '../../sandbox/events/sandbox-desired-state-updated.event'
import { RunnerEvents } from '../../sandbox/constants/runner-events'
import { RunnerDto } from '../../sandbox/dto/runner.dto'
import { RunnerCreatedEvent } from '../../sandbox/events/runner-created.event'
import { RunnerStateUpdatedEvent } from '../../sandbox/events/runner-state-updated.event'
import { RunnerUnschedulableUpdatedEvent } from '../../sandbox/events/runner-unschedulable-updated.event'
import { RegionService } from '../../region/services/region.service'
import { SandboxService } from '../../sandbox/services/sandbox.service'
import { InjectRedis } from '@nestjs-modules/ioredis'
import { Redis } from 'ioredis'
import { SANDBOX_EVENT_CHANNEL } from '../../common/constants/constants'

@Injectable()
export class NotificationService {
  constructor(
    private readonly notificationEmitter: NotificationEmitter,
    private readonly regionService: RegionService,
    private readonly sandboxService: SandboxService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  @OnEvent(SandboxEvents.CREATED)
  async handleSandboxCreated(event: SandboxCreatedEvent) {
    const dto = await this.sandboxService.toSandboxDto(event.sandbox)
    this.notificationEmitter.emitSandboxCreated(dto)
  }

  @OnEvent(SandboxEvents.STATE_UPDATED)
  async handleSandboxStateUpdated(event: SandboxStateUpdatedEvent) {
    const dto = await this.sandboxService.toSandboxDto(event.sandbox)
    this.notificationEmitter.emitSandboxStateUpdated(dto, event.oldState, event.newState)
    this.redis.publish(SANDBOX_EVENT_CHANNEL, JSON.stringify(event))
  }

  @OnEvent(SandboxEvents.DESIRED_STATE_UPDATED)
  async handleSandboxDesiredStateUpdated(event: SandboxDesiredStateUpdatedEvent) {
    const dto = await this.sandboxService.toSandboxDto(event.sandbox)
    this.notificationEmitter.emitSandboxDesiredStateUpdated(dto, event.oldDesiredState, event.newDesiredState)
    this.redis.publish(SANDBOX_EVENT_CHANNEL, JSON.stringify(event))
  }

  @OnEvent(SavedImageEvents.CREATED)
  async handleSavedImageCreated(event: SavedImageCreatedEvent) {
    const dto = SavedImageDto.fromSavedImageEntity(event.savedImage)
    this.notificationEmitter.emitSavedImageCreated(dto)
  }

  @OnEvent(SavedImageEvents.STATE_UPDATED)
  async handleSavedImageStateUpdated(event: SavedImageStateUpdatedEvent) {
    const dto = SavedImageDto.fromSavedImageEntity(event.savedImage)
    this.notificationEmitter.emitSavedImageStateUpdated(dto, event.oldState, event.newState)
  }

  @OnEvent(SavedImageEvents.REMOVED)
  async handleSavedImageRemoved(event: SavedImageRemovedEvent) {
    const dto = SavedImageDto.fromSavedImageEntity(event.savedImage)
    this.notificationEmitter.emitSavedImageRemoved(dto)
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
