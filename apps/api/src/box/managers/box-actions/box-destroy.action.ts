/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import { Box } from '../../entities/box.entity'
import { BoxState } from '../../enums/box-state.enum'
import { DONT_SYNC_AGAIN, BoxAction, SyncState, SYNC_AGAIN } from './box.action'
import { RunnerState } from '../../enums/runner-state.enum'
import { RunnerService } from '../../services/runner.service'
import { RunnerAdapterFactory } from '../../runner-adapter/runnerAdapter'
import { BoxRepository } from '../../repositories/box.repository'
import { LockCode, RedisLockProvider } from '../../common/redis-lock.provider'
import { WithSpan } from '../../../common/decorators/otel.decorator'
import { BoxSshReconciliationService } from '../../services/box-ssh-reconciliation.service'

@Injectable()
export class BoxDestroyAction extends BoxAction {
  constructor(
    protected runnerService: RunnerService,
    protected runnerAdapterFactory: RunnerAdapterFactory,
    protected boxRepository: BoxRepository,
    protected redisLockProvider: RedisLockProvider,
    private readonly boxSshReconciliationService: BoxSshReconciliationService,
  ) {
    super(runnerService, runnerAdapterFactory, boxRepository, redisLockProvider)
  }

  @WithSpan()
  async run(box: Box, lockCode: LockCode): Promise<SyncState> {
    if (box.state === BoxState.DESTROYED) {
      return DONT_SYNC_AGAIN
    }

    if (box.state === BoxState.ARCHIVED) {
      await this.updateBoxState(box, BoxState.DESTROYED, lockCode)
      await this.cleanupSshResources(box.id)
      return DONT_SYNC_AGAIN
    }

    const runner = await this.runnerService.findOneOrFail(box.runnerId)
    if (runner.state !== RunnerState.READY) {
      return DONT_SYNC_AGAIN
    }

    const runnerAdapter = await this.runnerAdapterFactory.create(runner)

    try {
      const boxInfo = await runnerAdapter.boxInfo(box.id)

      if (boxInfo.state === BoxState.DESTROYED) {
        await this.updateBoxState(box, BoxState.DESTROYED, lockCode)
        await this.cleanupSshResources(box.id)
        return DONT_SYNC_AGAIN
      }

      if (box.state !== BoxState.DESTROYING) {
        await runnerAdapter.destroyBox(box.id)
        await this.updateBoxState(box, BoxState.DESTROYING, lockCode)
      }

      return SYNC_AGAIN
    } catch (error) {
      //  if the box is not found on runner, it is already destroyed
      if (error.response?.status === 404 || error.statusCode === 404) {
        await this.updateBoxState(box, BoxState.DESTROYED, lockCode)
        await this.cleanupSshResources(box.id)
        return DONT_SYNC_AGAIN
      }

      throw error
    }
  }

  // Best-effort: a cleanup failure must not resurrect the box or block it
  // from being reported DESTROYED -- the rows are harmless leftovers (never
  // reachable again, since nothing can start guest SSH for a destroyed box)
  // and get caught by the next cleanup pass rather than this one throwing.
  private async cleanupSshResources(boxId: string): Promise<void> {
    try {
      await this.boxSshReconciliationService.cleanupForDestroyedBox(boxId)
    } catch (error) {
      this.logger.warn(`SSH resource cleanup failed for destroyed box ${boxId}: ${error.message}`)
    }
  }
}
