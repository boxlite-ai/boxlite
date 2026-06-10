/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { InjectRedis } from '@nestjs-modules/ioredis'
import { Injectable, Logger } from '@nestjs/common'
import { OnEvent } from '@nestjs/event-emitter'
import Redis from 'ioredis'

import { BoxEvents } from '../constants/box-events.constants'
import { BoxArchivedEvent } from '../events/box-archived.event'

@Injectable()
export class ProxyCacheInvalidationService {
  private readonly logger = new Logger(ProxyCacheInvalidationService.name)
  private static readonly RUNNER_INFO_CACHE_PREFIX = 'proxy:box-runner-info:'

  constructor(@InjectRedis() private readonly redis: Redis) {}

  @OnEvent(BoxEvents.ARCHIVED)
  async handleBoxArchived(event: BoxArchivedEvent): Promise<void> {
    await this.invalidateRunnerCache(event.box.id)
  }

  private async invalidateRunnerCache(boxId: string): Promise<void> {
    try {
      await this.redis.del(`${ProxyCacheInvalidationService.RUNNER_INFO_CACHE_PREFIX}${boxId}`)
      this.logger.debug(`Invalidated box runner cache for ${boxId}`)
    } catch (error) {
      this.logger.warn(`Failed to invalidate runner cache for box ${boxId}: ${error.message}`)
    }
  }
}
