/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { InjectRedis } from '@nestjs-modules/ioredis'
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import Redis from 'ioredis'
import { BadRequestError } from '../../exceptions/bad-request.exception'
import { BOX_EVENT_CHANNEL } from '../../common/constants/constants'
import { BoxDto } from '../dto/box.dto'
import { BoxState } from '../enums/box-state.enum'
import { BoxStateUpdatedEvent } from '../events/box-state-updated.event'
import { BoxService } from './box.service'

@Injectable()
export class BoxStateWaiterService implements OnModuleDestroy {
  private readonly logger = new Logger(BoxStateWaiterService.name)
  private readonly callbacks = new Map<string, (event: BoxStateUpdatedEvent) => void>()
  private readonly redisSubscriber: Redis

  constructor(
    private readonly boxService: BoxService,
    @InjectRedis() private readonly redis: Redis,
  ) {
    this.redisSubscriber = this.redis.duplicate()
    this.redisSubscriber.subscribe(BOX_EVENT_CHANNEL)
    this.redisSubscriber.on('message', (channel, message) => {
      if (channel !== BOX_EVENT_CHANNEL) {
        return
      }

      try {
        const event = JSON.parse(message) as BoxStateUpdatedEvent
        const callback = this.callbacks.get(event.box.id)
        if (callback) {
          callback(event)
        }
      } catch (error) {
        this.logger.error('Failed to parse box state updated event:', error)
      }
    })
  }

  async onModuleDestroy() {
    await this.redisSubscriber.quit()
  }

  async waitForStarted(boxId: string, organizationId: string, timeoutSeconds: number): Promise<BoxDto> {
    const current = await this.boxService.findOneByIdOrName(boxId, organizationId)

    if (current.state === BoxState.STARTED) {
      return this.boxService.toBoxDto(current)
    }

    this.assertNotFailed(current.state, current.errorReason)

    return new Promise<BoxDto>((resolve, reject) => {
      let latestBox = current
      let timeout: NodeJS.Timeout

      const finish = async (box = latestBox) => {
        this.callbacks.delete(boxId)
        clearTimeout(timeout)
        resolve(await this.boxService.toBoxDto(box))
      }

      const fail = (error: Error) => {
        this.callbacks.delete(boxId)
        clearTimeout(timeout)
        reject(error)
      }

      const handleStateUpdated = (event: BoxStateUpdatedEvent) => {
        if (event.box.id !== boxId) {
          return
        }

        latestBox = event.box

        if (event.box.state === BoxState.STARTED) {
          finish(event.box).catch(fail)
          return
        }

        try {
          this.assertNotFailed(event.box.state, event.box.errorReason)
        } catch (error) {
          fail(error)
        }
      }

      this.callbacks.set(boxId, handleStateUpdated)

      this.boxService
        .findOneByIdOrName(boxId, organizationId)
        .then((box) => {
          latestBox = box
          if (box.state === BoxState.STARTED) {
            return finish(box)
          }
          this.assertNotFailed(box.state, box.errorReason)
        })
        .catch(fail)

      timeout = setTimeout(() => {
        finish().catch(fail)
      }, timeoutSeconds * 1000)
    })
  }

  private assertNotFailed(state: BoxState, errorReason?: string | null) {
    if (state === BoxState.ERROR) {
      throw new BadRequestError(`Box failed to start: ${errorReason || 'Unknown error'}`)
    }
  }
}
