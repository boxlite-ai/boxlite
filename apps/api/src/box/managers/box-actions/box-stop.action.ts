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

@Injectable()
export class BoxStopAction extends BoxAction {
  constructor(
    protected runnerService: RunnerService,
    protected runnerAdapterFactory: RunnerAdapterFactory,
    protected boxRepository: BoxRepository,
    protected redisLockProvider: RedisLockProvider,
  ) {
    super(runnerService, runnerAdapterFactory, boxRepository, redisLockProvider)
  }

  @WithSpan()
  async run(box: Box, lockCode: LockCode, force?: boolean): Promise<SyncState> {
    const runner = await this.runnerService.findOneOrFail(box.runnerId)
    if (runner.state !== RunnerState.READY) {
      return DONT_SYNC_AGAIN
    }

    const runnerAdapter = await this.runnerAdapterFactory.create(runner)

    if (box.state === BoxState.STARTED) {
      // stop box
      await runnerAdapter.stopBox(box.id, force)
      await this.updateBoxState(box, BoxState.STOPPING, lockCode)

      //  sync states again immediately for box
      return SYNC_AGAIN
    }

    if (box.state !== BoxState.STOPPING && box.state !== BoxState.ERROR) {
      return DONT_SYNC_AGAIN
    }

    const boxInfo = await runnerAdapter.boxInfo(box.id)

    if (boxInfo.state === BoxState.STOPPED) {
      await this.updateBoxState(box, BoxState.STOPPED, lockCode)
      return DONT_SYNC_AGAIN
    } else if (boxInfo.state === BoxState.ERROR) {
      await this.updateBoxState(box, BoxState.ERROR, lockCode, undefined, 'Box is in error state on runner')
      return DONT_SYNC_AGAIN
    }

    return SYNC_AGAIN
  }
}
