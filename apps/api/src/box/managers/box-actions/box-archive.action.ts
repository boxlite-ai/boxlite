/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import { Box } from '../../entities/box.entity'
import { BoxState } from '../../enums/box-state.enum'
import { DONT_SYNC_AGAIN, BoxAction, SyncState, SYNC_AGAIN } from './box.action'
import { BackupState } from '../../enums/backup-state.enum'
import { LockCode, RedisLockProvider } from '../../common/redis-lock.provider'
import { RunnerService } from '../../services/runner.service'
import { BoxRepository } from '../../repositories/box.repository'
import { InjectRedis } from '@nestjs-modules/ioredis'
import Redis from 'ioredis'
import { RunnerAdapterFactory } from '../../runner-adapter/runnerAdapter'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { BoxEvents } from '../../constants/box-events.constants'
import { BoxBackupCreatedEvent } from '../../events/box-backup-created.event'
import { WithSpan } from '../../../common/decorators/otel.decorator'

@Injectable()
export class BoxArchiveAction extends BoxAction {
  constructor(
    protected runnerService: RunnerService,
    protected runnerAdapterFactory: RunnerAdapterFactory,
    protected boxRepository: BoxRepository,
    protected readonly redisLockProvider: RedisLockProvider,
    @InjectRedis() private readonly redis: Redis,
    private readonly eventEmitter: EventEmitter2,
  ) {
    super(runnerService, runnerAdapterFactory, boxRepository, redisLockProvider)
  }

  @WithSpan()
  async run(box: Box, lockCode: LockCode): Promise<SyncState> {
    // Only proceed with archiving if the box is in STOPPED, ARCHIVING or ERROR (runner draining) state.
    // For all other states, do not proceed with archiving.
    if (box.state !== BoxState.STOPPED && box.state !== BoxState.ARCHIVING && box.state !== BoxState.ERROR) {
      return DONT_SYNC_AGAIN
    }

    const lockKey = 'archive-lock-' + box.runnerId
    if (!(await this.redisLockProvider.lock(lockKey, 10))) {
      return DONT_SYNC_AGAIN
    }

    const isFromErrorState = box.state === BoxState.ERROR

    await this.redisLockProvider.unlock(lockKey)

    //  if the backup state is error, we need to retry the backup
    if (box.backupState === BackupState.ERROR) {
      const archiveErrorRetryKey = 'archive-error-retry-' + box.id
      const archiveErrorRetryCountRaw = await this.redis.get(archiveErrorRetryKey)
      const archiveErrorRetryCount = archiveErrorRetryCountRaw ? parseInt(archiveErrorRetryCountRaw) : 0
      //  if the archive error retry count is greater than 3, we need to mark the box as error
      if (archiveErrorRetryCount > 3) {
        // Only transition to ERROR if not already in ERROR state
        if (!isFromErrorState) {
          await this.updateBoxState(box, BoxState.ERROR, lockCode, undefined, 'Failed to archive box after 3 retries')
        }
        await this.redis.del(archiveErrorRetryKey)
        return DONT_SYNC_AGAIN
      }
      await this.redis.setex('archive-error-retry-' + box.id, 720, String(archiveErrorRetryCount + 1))

      // recreate the backup to retry
      this.eventEmitter.emit(BoxEvents.BACKUP_CREATED, new BoxBackupCreatedEvent(box))

      return DONT_SYNC_AGAIN
    }

    if (box.backupState !== BackupState.COMPLETED) {
      return DONT_SYNC_AGAIN
    }

    //  when the backup is completed, destroy the box on the runner
    //  and deassociate the box from the runner
    const runner = await this.runnerService.findOneOrFail(box.runnerId)
    const runnerAdapter = await this.runnerAdapterFactory.create(runner)

    try {
      const boxInfo = await runnerAdapter.boxInfo(box.id)
      if (boxInfo.state === BoxState.DESTROYED) {
        if (isFromErrorState) {
          this.logger.warn(`Transitioning box ${box.id} from ERROR to ARCHIVED state (runner draining)`)
        }

        await this.updateBoxState(box, BoxState.ARCHIVED, lockCode, null)
        return DONT_SYNC_AGAIN
      }

      if (boxInfo.state !== BoxState.DESTROYING) {
        await runnerAdapter.destroyBox(box.id)
      }

      return SYNC_AGAIN
    } catch (error) {
      //  fail for errors other than box not found or box already destroyed
      if (
        (error.response?.data?.statusCode === 400 && error.response?.data?.message.includes('Box already destroyed')) ||
        error.response?.status === 404 ||
        error.statusCode === 404
      ) {
        //  if the box is already destroyed, do nothing
        if (isFromErrorState) {
          this.logger.warn(`Transitioning box ${box.id} from ERROR to ARCHIVED state (runner draining)`)
        }

        await this.updateBoxState(box, BoxState.ARCHIVED, lockCode, null)
        return DONT_SYNC_AGAIN
      }

      throw error
    }
  }
}
