/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { InjectRedis } from '@nestjs-modules/ioredis'
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import Redis from 'ioredis'
import { BadRequestError } from '../../exceptions/bad-request.exception'
import { SANDBOX_EVENT_CHANNEL } from '../../common/constants/constants'
import { SandboxDto } from '../dto/sandbox.dto'
import { SandboxState } from '../enums/sandbox-state.enum'
import { SandboxStateUpdatedEvent } from '../events/sandbox-state-updated.event'
import { SandboxService } from './sandbox.service'

@Injectable()
export class SandboxStateWaiterService implements OnModuleDestroy {
  private readonly logger = new Logger(SandboxStateWaiterService.name)
  private readonly callbacks = new Map<string, (event: SandboxStateUpdatedEvent) => void>()
  private readonly redisSubscriber: Redis

  constructor(
    private readonly sandboxService: SandboxService,
    @InjectRedis() private readonly redis: Redis,
  ) {
    this.redisSubscriber = this.redis.duplicate()
    this.redisSubscriber.subscribe(SANDBOX_EVENT_CHANNEL)
    this.redisSubscriber.on('message', (channel, message) => {
      if (channel !== SANDBOX_EVENT_CHANNEL) {
        return
      }

      try {
        const event = JSON.parse(message) as SandboxStateUpdatedEvent
        const callback = this.callbacks.get(event.sandbox.id)
        if (callback) {
          callback(event)
        }
      } catch (error) {
        this.logger.error('Failed to parse sandbox state updated event:', error)
      }
    })
  }

  async onModuleDestroy() {
    await this.redisSubscriber.quit()
  }

  async waitForStarted(
    sandboxId: string,
    organizationId: string,
    timeoutSeconds: number,
  ): Promise<SandboxDto> {
    const current = await this.sandboxService.findOneByIdOrName(
      sandboxId,
      organizationId,
    )

    if (current.state === SandboxState.STARTED) {
      return this.sandboxService.toSandboxDto(current)
    }

    this.assertNotFailed(current.state, current.errorReason)

    return new Promise<SandboxDto>((resolve, reject) => {
      let latestSandbox = current
      let timeout: NodeJS.Timeout

      const finish = async (sandbox = latestSandbox) => {
        this.callbacks.delete(sandboxId)
        clearTimeout(timeout)
        resolve(await this.sandboxService.toSandboxDto(sandbox))
      }

      const fail = (error: Error) => {
        this.callbacks.delete(sandboxId)
        clearTimeout(timeout)
        reject(error)
      }

      const handleStateUpdated = (event: SandboxStateUpdatedEvent) => {
        if (event.sandbox.id !== sandboxId) {
          return
        }

        latestSandbox = event.sandbox

        if (event.sandbox.state === SandboxState.STARTED) {
          finish(event.sandbox).catch(fail)
          return
        }

        try {
          this.assertNotFailed(event.sandbox.state, event.sandbox.errorReason)
        } catch (error) {
          fail(error)
        }
      }

      this.callbacks.set(sandboxId, handleStateUpdated)

      this.sandboxService
        .findOneByIdOrName(sandboxId, organizationId)
        .then((sandbox) => {
          latestSandbox = sandbox
          if (sandbox.state === SandboxState.STARTED) {
            return finish(sandbox)
          }
          this.assertNotFailed(sandbox.state, sandbox.errorReason)
        })
        .catch(fail)

      timeout = setTimeout(() => {
        finish().catch(fail)
      }, timeoutSeconds * 1000)
    })
  }

  private assertNotFailed(state: SandboxState, errorReason?: string | null) {
    if (state === SandboxState.ERROR || state === SandboxState.BUILD_FAILED) {
      throw new BadRequestError(
        `Sandbox failed to start: ${errorReason || 'Unknown error'}`,
      )
    }
  }
}
