/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, RequestTimeoutException } from '@nestjs/common'
import { BoxService } from '../box/services/box.service'
import { BoxStateWaiterService } from '../box/services/box-state-waiter.service'
import { RedisLockProvider } from '../box/common/redis-lock.provider'
import { getStateChangeLockKey } from '../box/utils/lock-key.util'
import { Box } from '../box/entities/box.entity'
import { BoxState } from '../box/enums/box-state.enum'
import { BoxDesiredState } from '../box/enums/box-desired-state.enum'
import { Organization } from '../organization/entities/organization.entity'

const AUTO_RESUME_TIMEOUT_SECONDS = 30

@Injectable()
export class BoxAutoResumeService {
  constructor(
    private readonly boxService: BoxService,
    private readonly boxStateWaiter: BoxStateWaiterService,
    private readonly redisLockProvider: RedisLockProvider,
  ) {}

  /** Submit or join Start and return only after the Box is actually STARTED. */
  async ensureReady(boxId: string, organization: Organization): Promise<void> {
    let box = await this.submitOrJoinStart(boxId, organization)

    const stopping =
      box.state === BoxState.STOPPING ||
      (box.state === BoxState.STARTED && box.desiredState === BoxDesiredState.STOPPED)
    if (stopping) {
      await this.boxStateWaiter.waitForStopped(box.id, organization.id, AUTO_RESUME_TIMEOUT_SECONDS)
      box = await this.submitOrJoinStart(box.id, organization)
    }

    if (box.state !== BoxState.STARTED) {
      await this.boxStateWaiter.waitForStarted(box.id, organization.id, AUTO_RESUME_TIMEOUT_SECONDS)
    }
  }

  private async submitOrJoinStart(boxId: string, organization: Organization): Promise<Box> {
    const lockKey = getStateChangeLockKey(boxId)
    const deadline = Date.now() + AUTO_RESUME_TIMEOUT_SECONDS * 1000
    while (!(await this.redisLockProvider.lock(lockKey, AUTO_RESUME_TIMEOUT_SECONDS))) {
      if (Date.now() >= deadline) {
        throw new RequestTimeoutException(`Timed out waiting to resume box ${boxId}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    try {
      return await this.boxService.ensureStartedForProxy(boxId, organization)
    } finally {
      await this.redisLockProvider.unlock(lockKey)
    }
  }
}
