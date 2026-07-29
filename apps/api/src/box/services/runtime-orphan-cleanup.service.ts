/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { DataSource, IsNull } from 'typeorm'
import { BoxRuntimeCleanup } from '../entities/box-runtime-cleanup.entity'
import { Job } from '../entities/job.entity'
import { JobConflictError } from '../errors/job-conflict.error'
import { JobStatus } from '../enums/job-status.enum'
import { JobType } from '../enums/job-type.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { JobService } from './job.service'
import { RuntimeCleanupTarget } from './runtime-lease.service'

const CLEANUP_BATCH_SIZE = 100

@Injectable()
export class RuntimeOrphanCleanupService {
  private readonly logger = new Logger(RuntimeOrphanCleanupService.name)

  constructor(
    private readonly dataSource: DataSource,
    private readonly jobService: JobService,
  ) {}

  async enqueueTargets(targets: RuntimeCleanupTarget[]): Promise<void> {
    for (const target of targets) {
      await this.enqueueTarget(target)
    }
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'reconcile-runtime-orphan-cleanups', waitForCompletion: true })
  async reconcilePendingCleanups(): Promise<void> {
    const unassigned = await this.dataSource.getRepository(BoxRuntimeCleanup).find({
      where: { jobId: IsNull() },
      order: { createdAt: 'ASC', id: 'ASC' },
      take: CLEANUP_BATCH_SIZE,
    })
    const failed = await this.dataSource
      .getRepository(BoxRuntimeCleanup)
      .createQueryBuilder('cleanup')
      .innerJoin(Job, 'job', 'job.id = cleanup."jobId"')
      .where('job.status = :status', { status: JobStatus.FAILED })
      .orderBy('cleanup.createdAt', 'ASC')
      .addOrderBy('cleanup.id', 'ASC')
      .take(CLEANUP_BATCH_SIZE)
      .getMany()
    for (const cleanup of [...unassigned, ...failed]) {
      await this.enqueueTarget(cleanup)
    }
  }

  private async enqueueTarget(target: RuntimeCleanupTarget): Promise<void> {
    try {
      await this.dataSource.transaction(async (manager) => {
        const cleanup = await manager.findOne(BoxRuntimeCleanup, {
          where: {
            boxId: target.boxId,
            runnerId: target.runnerId,
            runnerEpoch: target.runnerEpoch,
            runtimeGeneration: target.runtimeGeneration,
          },
          lock: { mode: 'pessimistic_write' },
        })
        if (!cleanup) {
          return
        }
        if (cleanup.jobId) {
          const currentJob = await manager.findOne(Job, {
            where: { id: cleanup.jobId },
            lock: { mode: 'pessimistic_read' },
          })
          if (!currentJob || currentJob.status !== JobStatus.FAILED) {
            return
          }
          cleanup.jobId = null
        }

        const job = await this.jobService.createJob(
          manager,
          JobType.STOP_ORPHAN_RUNTIME,
          cleanup.runnerId,
          ResourceType.BOX,
          cleanup.boxId,
          {
            force: true,
            runnerEpoch: cleanup.runnerEpoch,
            runtimeGeneration: cleanup.runtimeGeneration,
          },
        )
        cleanup.jobId = job.id
        await manager.save(BoxRuntimeCleanup, cleanup)
      })
    } catch (error) {
      if (error instanceof JobConflictError) {
        this.logger.debug(`Runtime cleanup for Box ${target.boxId} is waiting for the current runner job to complete`)
        return
      }
      this.logger.error(
        `Failed to enqueue runtime cleanup for Box ${target.boxId}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}
