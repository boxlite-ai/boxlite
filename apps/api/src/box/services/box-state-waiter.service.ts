/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { InjectRedis } from '@nestjs-modules/ioredis'
import { Injectable, Logger, OnModuleDestroy, RequestTimeoutException } from '@nestjs/common'
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
  private readonly callbacks = new Map<string, Set<(event: BoxStateUpdatedEvent) => void>>()
  private redisSubscriber?: Redis
  private subscription?: Promise<void>

  constructor(
    private readonly boxService: BoxService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async onModuleDestroy() {
    if (this.redisSubscriber) await this.redisSubscriber.quit()
  }

  private ensureSubscribed(): Promise<void> {
    if (this.subscription) return this.subscription
    this.redisSubscriber = this.redis.duplicate()
    this.redisSubscriber.on('message', (channel, message) => {
      if (channel !== BOX_EVENT_CHANNEL) return
      try {
        const event = JSON.parse(message) as BoxStateUpdatedEvent
        for (const callback of this.callbacks.get(event.box.id) ?? []) callback(event)
      } catch (error) {
        this.logger.error('Failed to parse box state updated event:', error)
      }
    })
    this.subscription = this.redisSubscriber
      .subscribe(BOX_EVENT_CHANNEL)
      .then(() => undefined)
      .catch((error) => {
        this.subscription = undefined
        throw error
      })
    return this.subscription
  }

  waitForStarted(boxId: string, organizationId: string, timeoutSeconds: number): Promise<BoxDto> {
    return this.waitForState(boxId, organizationId, BoxState.STARTED, timeoutSeconds)
  }

  waitForStopped(boxId: string, organizationId: string, timeoutSeconds: number): Promise<BoxDto> {
    return this.waitForState(boxId, organizationId, BoxState.STOPPED, timeoutSeconds)
  }

  private async waitForState(
    boxId: string,
    organizationId: string,
    targetState: BoxState,
    timeoutSeconds: number,
  ): Promise<BoxDto> {
    const current = await this.boxService.findOneByIdOrName(boxId, organizationId)
    if (current.state === targetState) return this.boxService.toBoxDto(current)
    await this.ensureSubscribed()
    this.assertNotFailed(current.state, current.errorReason)

    return new Promise<BoxDto>((resolve, reject) => {
      let finished = false
      let timeout: NodeJS.Timeout

      const cleanup = () => {
        const callbacks = this.callbacks.get(boxId)
        callbacks?.delete(handleStateUpdated)
        if (callbacks?.size === 0) this.callbacks.delete(boxId)
        clearTimeout(timeout)
      }
      const finish = async (eventBox: BoxStateUpdatedEvent['box']) => {
        if (finished) return
        finished = true
        cleanup()
        try {
          resolve(await this.boxService.toBoxDto(eventBox))
        } catch (error) {
          reject(error)
        }
      }
      const fail = (error: unknown) => {
        if (finished) return
        finished = true
        cleanup()
        reject(error)
      }
      const handleStateUpdated = (event: BoxStateUpdatedEvent) => {
        if (event.box.state === targetState) {
          finish(event.box).catch(fail)
          return
        }
        try {
          this.assertNotFailed(event.box.state, event.box.errorReason)
        } catch (error) {
          fail(error)
        }
      }

      const callbacks = this.callbacks.get(boxId) ?? new Set()
      callbacks.add(handleStateUpdated)
      this.callbacks.set(boxId, callbacks)

      // Re-read after subscribing so an event between the first read and
      // registration cannot leave this waiter sleeping until timeout.
      this.boxService
        .findOneByIdOrName(boxId, organizationId)
        .then((box) => {
          if (box.state === targetState) return finish(box)
          this.assertNotFailed(box.state, box.errorReason)
        })
        .catch(fail)

      timeout = setTimeout(() => {
        fail(new RequestTimeoutException(`Timed out waiting for box ${boxId} to reach ${targetState}`))
      }, timeoutSeconds * 1000)
    })
  }

  private assertNotFailed(state: BoxState, errorReason?: string | null) {
    if (state === BoxState.ERROR) {
      throw new BadRequestError(`Box state transition failed: ${errorReason || 'Unknown error'}`)
    }
    if (state === BoxState.DESTROYED || state === BoxState.DESTROYING) {
      throw new BadRequestError('Box has been destroyed and cannot be resumed')
    }
  }
}
