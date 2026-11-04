/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0 */

import { Inject, Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource, In, IsNull, Not } from 'typeorm'
import { BoxCheckpoint, BoxCheckpointOperation } from '../entities/box-checkpoint.entity'
import { Box } from '../entities/box.entity'
import { Job } from '../entities/job.entity'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { JobStatus } from '../enums/job-status.enum'
import { JobType } from '../enums/job-type.enum'
import { BoxRepository } from '../repositories/box.repository'
import { RedisLockProvider } from '../common/redis-lock.provider'
import { SNAPSHOT_ARCHIVE_STORE, SnapshotArchiveStore } from '../stores/snapshot-archive.store'

export const CHECKPOINT_JOB_TYPES = [
  JobType.PAUSE_BOX,
  JobType.RESUME_BOX,
  JobType.CREATE_CHECKPOINT,
  JobType.IMPORT_CHECKPOINT,
]
export function isCheckpointJobType(type: JobType): boolean {
  return CHECKPOINT_JOB_TYPES.includes(type)
}

/** Durable operation rows, rather than a new import attempt, reconcile lost completions. */
@Injectable()
export class BoxCheckpointSettler {
  private readonly logger = new Logger(BoxCheckpointSettler.name)
  constructor(
    @InjectDataSource() private readonly source: DataSource,
    private readonly boxes: BoxRepository,
    private readonly locks: RedisLockProvider,
    @Inject(SNAPSHOT_ARCHIVE_STORE) private readonly store: SnapshotArchiveStore | null,
  ) {}

  async settle(job: Job): Promise<void> {
    if (![JobStatus.COMPLETED, JobStatus.FAILED].includes(job.status)) return
    const result = job.getResultMetadata() as Record<string, any> | null
    // A stale-job timeout is not proof that native work stopped using its files.
    if (result?.nativeCompleted !== true) return
    const selected = await this.source
      .getRepository(BoxCheckpointOperation)
      .findOneBy({ jobId: job.id, state: 'pending' })
    if (!selected || result.operationId !== selected.id) return
    await this.source.transaction(async (manager) => {
      const box = await manager.findOne(Box, {
        where: { id: selected.boxId },
        lock: { mode: 'pessimistic_write' },
        loadEagerRelations: false,
      })
      const checkpoint = selected.checkpointId
        ? await manager.findOne(BoxCheckpoint, {
            where: { id: selected.checkpointId, organizationId: selected.organizationId },
            lock: { mode: 'pessimistic_write' },
          })
        : null
      const operation = await manager.findOne(BoxCheckpointOperation, {
        where: { id: selected.id, jobId: job.id, state: 'pending' },
        lock: { mode: 'pessimistic_write' },
      })
      if (!operation) return
      const deleted = !box || box.desiredState === BoxDesiredState.DESTROYED
      const expectedState = operation.kind === 'resume' ? 'started' : 'paused'
      let success = !deleted && job.status === JobStatus.COMPLETED && result.state === expectedState
      if (operation.kind === 'capture') {
        success &&=
          checkpoint?.state === 'creating' &&
          result.checkpointId === checkpoint.id &&
          Number.isSafeInteger(result.sizeBytes) &&
          result.sizeBytes > 0 &&
          /^[0-9a-f]{64}$/.test(result.contentSha256 ?? '') &&
          /^[0-9a-f]{64}$/.test(result.bootDiskSha256 ?? '')
        if (checkpoint)
          await manager.update(
            BoxCheckpoint,
            { id: checkpoint.id },
            success
              ? {
                  state: 'ready',
                  sizeBytes: result.sizeBytes,
                  contentSha256: result.contentSha256,
                  bootDiskSha256: result.bootDiskSha256,
                  errorReason: null,
                }
              : {
                  state: 'failed',
                  errorReason: deleted
                    ? 'Source was deleted during checkpoint capture'
                    : 'Checkpoint capture failed or returned an invalid completion',
                },
          )
      }
      await manager.update(
        BoxCheckpointOperation,
        { id: operation.id },
        {
          state: success ? 'succeeded' : 'failed',
          error: success
            ? null
            : {
                message: job.errorMessage || 'Checkpoint operation failed',
                ...(result.error ? { error: result.error } : {}),
              },
        },
      )
      if (box?.checkpointOperationId === operation.id) {
        const state = success
          ? expectedState === 'started'
            ? BoxState.STARTED
            : BoxState.PAUSED
          : result.state === 'paused'
            ? BoxState.PAUSED
            : result.state === 'started'
              ? BoxState.STARTED
              : BoxState.ERROR
        await this.boxes.updateWhere(
          box.id,
          {
            updateData: {
              checkpointOperationId: null,
              initialCheckpointId: operation.kind === 'restore' ? null : box.initialCheckpointId,
              ...(!deleted
                ? {
                    state,
                    desiredState:
                      state === BoxState.PAUSED
                        ? BoxDesiredState.PAUSED
                        : state === BoxState.STARTED
                          ? BoxDesiredState.STARTED
                          : box.desiredState,
                    recoverable: false,
                    errorReason: success ? null : 'Checkpoint operation failed',
                  }
                : {}),
            },
            whereCondition: { checkpointOperationId: operation.id },
          },
          manager,
        )
      }
    })
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'box-checkpoint-reconcile' })
  async reconcile(): Promise<void> {
    if (!(await this.locks.lock('box-checkpoint-reconcile', 60))) return
    try {
      const operations = await this.source
        .getRepository(BoxCheckpointOperation)
        .find({ where: { state: 'pending' }, take: 100 })
      for (const operation of operations) {
        const job = await this.source.getRepository(Job).findOneBy({ id: operation.jobId })
        if (!job) continue
        if (job.status === JobStatus.PENDING && job.createdAt.getTime() < Date.now() - 600_000) {
          await this.source.getRepository(Job).update(
            { id: job.id, status: JobStatus.PENDING },
            {
              status: JobStatus.FAILED,
              completedAt: new Date(),
              errorMessage: 'Checkpoint job was not claimed',
              resultMetadata: JSON.stringify({ operationId: operation.id, nativeCompleted: true, state: 'unknown' }),
            },
          )
        }
        await this.settle(await this.source.getRepository(Job).findOneByOrFail({ id: job.id }))
      }
      await this.releaseFailedChildren()
      await this.reap()
    } catch (error) {
      this.logger.error('Checkpoint reconciliation failed', error)
    } finally {
      await this.locks.unlock('box-checkpoint-reconcile')
    }
  }

  private async releaseFailedChildren(): Promise<void> {
    const failed = await this.source.getRepository(Box).find({
      where: { state: In([BoxState.ERROR, BoxState.DESTROYED]), initialCheckpointId: Not(IsNull()) },
      take: 100,
    })
    for (const child of failed) {
      if (
        !child.checkpointOperationId &&
        !(await this.source.getRepository(Job).exists({
          where: {
            resourceId: child.id,
            type: JobType.IMPORT_CHECKPOINT,
            status: In([JobStatus.PENDING, JobStatus.IN_PROGRESS]),
          },
        }))
      ) {
        await this.boxes.updateWhere(child.id, {
          updateData: { initialCheckpointId: null, recoverable: false },
          whereCondition: { state: child.state, checkpointOperationId: IsNull() },
        })
      }
    }
  }

  private async reap(): Promise<void> {
    if (!this.store) return
    const repository = this.source.getRepository(BoxCheckpoint)
    for (const checkpoint of await repository.find({
      where: [{ state: 'deleting' }, { state: 'failed', archiveUri: Not('') }],
      take: 100,
    })) {
      if (
        await this.source
          .getRepository(BoxCheckpointOperation)
          .exists({ where: { checkpointId: checkpoint.id, state: 'pending' } })
      )
        continue
      try {
        if (checkpoint.archiveUri) await this.store.delete(checkpoint.archiveUri)
        if (checkpoint.state === 'deleting') await repository.delete({ id: checkpoint.id, state: 'deleting' })
        else await repository.update({ id: checkpoint.id, state: 'failed' }, { archiveUri: '' })
      } catch (error) {
        this.logger.error(`Checkpoint ${checkpoint.id} cleanup failed`, error)
      }
    }
  }
}
