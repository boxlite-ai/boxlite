/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { RunnerService } from '../../services/runner.service'
import { RunnerAdapterFactory } from '../../runner-adapter/runnerAdapter'
import { Box } from '../../entities/box.entity'
import { BoxRepository } from '../../repositories/box.repository'
import { BoxState } from '../../enums/box-state.enum'
import { getStateChangeLockKey } from '../../utils/lock-key.util'
import { LockCode, RedisLockProvider } from '../../common/redis-lock.provider'

export const SYNC_AGAIN = 'sync-again'
export const DONT_SYNC_AGAIN = 'dont-sync-again'
export type SyncState = typeof SYNC_AGAIN | typeof DONT_SYNC_AGAIN

@Injectable()
export abstract class BoxAction {
  protected readonly logger = new Logger(BoxAction.name)

  constructor(
    protected readonly runnerService: RunnerService,
    protected runnerAdapterFactory: RunnerAdapterFactory,
    protected readonly boxRepository: BoxRepository,
    protected readonly redisLockProvider: RedisLockProvider,
  ) {}

  abstract run(box: Box, lockCode: LockCode): Promise<SyncState>

  protected async updateBoxState(
    box: Box,
    state: BoxState,
    expectedLockCode: LockCode,
    runnerId?: string | null | undefined,
    errorReason?: string,
    daemonVersion?: string,
    recoverable?: boolean,
  ) {
    //  check if the lock code is still valid
    const lockKey = getStateChangeLockKey(box.id)
    const currentLockCode = await this.redisLockProvider.getCode(lockKey)

    if (currentLockCode === null) {
      this.logger.warn(
        `no lock code found - state update action expired - skipping - boxId: ${box.id} - state: ${state}`,
      )
      return
    }

    if (expectedLockCode.getCode() !== currentLockCode.getCode()) {
      this.logger.warn(
        `lock code mismatch - state update action expired - skipping - boxId: ${box.id} - state: ${state}`,
      )
      return
    }

    if (!box.pending) {
      const err = new Error(`box ${box.id} is not in a pending state`)
      this.logger.error(err)
      return
    }

    const updateData: Partial<Box> = {
      state,
    }

    if (runnerId !== undefined) {
      updateData.runnerId = runnerId
    }

    if (errorReason !== undefined) {
      updateData.errorReason = errorReason
      if (state === BoxState.ERROR) {
        updateData.recoverable = recoverable ?? false
      }
    }

    if (box.state === BoxState.ERROR && !box.errorReason) {
      updateData.errorReason = 'Box is in error state during update'
      updateData.recoverable = false
    }

    if (daemonVersion !== undefined) {
      updateData.daemonVersion = daemonVersion
    }

    if (recoverable !== undefined) {
      updateData.recoverable = recoverable
    }

    await this.boxRepository.update(box.id, { updateData, entity: box })
  }
}
