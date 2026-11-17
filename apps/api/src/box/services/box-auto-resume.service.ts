/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, RequestTimeoutException } from '@nestjs/common'
import { BoxService, ProxyAdmission } from './box.service'
import { BoxStateWaiterService } from './box-state-waiter.service'
import { RedisLockProvider } from '../common/redis-lock.provider'
import { getStateChangeLockKey } from '../utils/lock-key.util'
import { Box } from '../entities/box.entity'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { Organization } from '../../organization/entities/organization.entity'
import { Context } from '../../common/context/context'
import { PlatformReason } from '../../common/context/platform-reason.enum'
import { beginBoxOperation } from '../utils/box-operation.util'
import { RequestTiming, requestTiming } from '../../common/utils/request-timing.util'

export const AUTO_RESUME_TIMEOUT_SECONDS = 30

// States an auto-resume may wait out: either the box is stopped (or on its
// way there) and can be started again, or it is already on its way up. Every
// other non-STARTED state — ERROR, ARCHIVED/ARCHIVING, DESTROYED/DESTROYING,
// RESIZING, UNKNOWN — either never reaches STARTED on its own or needs an
// explicit operator action, so waiting 30s to time out is strictly worse for
// the caller than an immediate refusal.
export const AUTO_RESUMABLE_STATES: readonly BoxState[] = [
  BoxState.STOPPED,
  BoxState.STOPPING,
  BoxState.STARTING,
  BoxState.CREATING,
  BoxState.RESTORING,
]

@Injectable()
export class BoxAutoResumeService {
  constructor(
    private readonly boxService: BoxService,
    private readonly boxStateWaiter: BoxStateWaiterService,
    private readonly redisLockProvider: RedisLockProvider,
  ) {}

  /** Submit or join Start and return only after the Box is actually STARTED. */
  async ensureReady(
    boxId: string,
    organization: Organization,
    admit?: ProxyAdmission,
    timing: RequestTiming = requestTiming(),
  ): Promise<void> {
    let finish: ReturnType<typeof beginBoxOperation> | undefined
    const begin = () =>
      beginBoxOperation({
        kind: 'resume',
        organizationId: organization.id,
        ctx: Context.platform(PlatformReason.AUTO_RESUME),
        scope: 'proxy_api',
        boxId,
        timing,
      })
    try {
      let box = await this.submitOrJoinStart(boxId, organization, admit)
      const stopping =
        box.state === BoxState.STOPPING ||
        (box.state === BoxState.STARTED && box.desiredState === BoxDesiredState.STOPPED)
      if (box.state === BoxState.STARTED && !stopping) return
      finish = begin()
      if (stopping) {
        await this.boxStateWaiter.waitForStopped(box.id, organization.id, AUTO_RESUME_TIMEOUT_SECONDS)
        box = await this.submitOrJoinStart(box.id, organization, admit)
      }
      if (box.state !== BoxState.STARTED) {
        await this.boxStateWaiter.waitForStarted(box.id, organization.id, AUTO_RESUME_TIMEOUT_SECONDS)
      }
      finish({ outcome: 'success', boxId: box.id })
    } catch (error) {
      finish ??= begin()
      finish({ outcome: 'exception', error })
      throw error
    }
  }

  private async submitOrJoinStart(boxId: string, organization: Organization, admit?: ProxyAdmission): Promise<Box> {
    const lockKey = getStateChangeLockKey(boxId)
    const deadline = Date.now() + AUTO_RESUME_TIMEOUT_SECONDS * 1000
    while (!(await this.redisLockProvider.lock(lockKey, AUTO_RESUME_TIMEOUT_SECONDS))) {
      if (Date.now() >= deadline) {
        throw new RequestTimeoutException(`Timed out waiting to resume box ${boxId}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    try {
      return await this.boxService.ensureStartedForProxy(boxId, organization, admit)
    } finally {
      await this.redisLockProvider.unlock(lockKey)
    }
  }
}
