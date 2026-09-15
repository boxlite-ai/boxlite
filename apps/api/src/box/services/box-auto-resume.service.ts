/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ConflictException, Injectable, RequestTimeoutException } from '@nestjs/common'
import { BoxService } from './box.service'
import { BoxStateWaiterService } from './box-state-waiter.service'
import { RedisLockProvider } from '../common/redis-lock.provider'
import { getStateChangeLockKey } from '../utils/lock-key.util'
import { Box } from '../entities/box.entity'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { Organization } from '../../organization/entities/organization.entity'

export const AUTO_RESUME_TIMEOUT_SECONDS = 30

// States a resume can actually wait out: the box is stopped (or on its way
// there) and can be started again, or it is already on its way up. Every other
// non-STARTED state — ERROR, ARCHIVED/ARCHIVING, DESTROYED/DESTROYING,
// RESIZING, UNKNOWN — either never reaches STARTED on its own or needs an
// operator, so waiting out the full window is strictly worse for the caller
// than failing now.
export const RESUMABLE_STATES: readonly BoxState[] = [
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

  /**
   * Submit or join Start and return only after the Box is actually STARTED.
   *
   * The eligibility gates live here rather than in each caller: a resume that
   * is not allowed must be refused the same way whether the request arrived
   * over REST, over a WebSocket attach, or at a preview URL. Callers that
   * already hold the box may still check first to skip the round trip, but
   * none of them is the place where the policy is decided.
   */
  async ensureReady(boxId: string, organization: Organization): Promise<void> {
    await this.assertResumable(boxId, organization)

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

  // Refuses a resume the box did not opt into, and one that could never
  // succeed. Both matter to the caller in the same way — the request is not
  // going to be served — but for opposite reasons: autoResume off is the
  // owner's decision, an unresumable state is the platform's.
  private async assertResumable(boxId: string, organization: Organization): Promise<void> {
    const box = await this.boxService.findOneByIdOrName(boxId, organization.id)

    // Already running and staying that way: nothing to authorize.
    if (box.state === BoxState.STARTED && box.desiredState === BoxDesiredState.STARTED) {
      return
    }

    if (!box.autoResume) {
      throw new ConflictException(`Box ${boxId} has auto-resume disabled (state: ${box.state})`)
    }

    // A box that is STARTED but heading to STOPPED is resumable — ensureReady
    // waits out the stop and starts it again — so only genuinely non-running
    // states are checked against the whitelist.
    if (box.state !== BoxState.STARTED && !RESUMABLE_STATES.includes(box.state)) {
      throw new ConflictException(`Box ${boxId} is not running (state: ${box.state})`)
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
