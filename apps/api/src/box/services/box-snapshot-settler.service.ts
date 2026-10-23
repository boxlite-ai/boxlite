/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Inject, Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource, EntityManager, In, LessThan, Not } from 'typeorm'

import { RedisLockProvider } from '../common/redis-lock.provider'
import { Box } from '../entities/box.entity'
import { BoxSnapshot } from '../entities/box-snapshot.entity'
import { BoxSnapshotRestore } from '../entities/box-snapshot-restore.entity'
import { Job } from '../entities/job.entity'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxSnapshotRestoreState } from '../enums/box-snapshot-restore-state.enum'
import { BoxSnapshotState } from '../enums/box-snapshot-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { JobStatus } from '../enums/job-status.enum'
import { JobType } from '../enums/job-type.enum'
import { BoxRepository } from '../repositories/box.repository'
import { SNAPSHOT_ARCHIVE_STORE, SnapshotArchiveStore } from '../stores/snapshot-archive.store'
import { sanitizeBoxError } from '../utils/sanitize-error.util'
import { LogExecution } from '../../common/decorators/log-execution.decorator'
import { WithInstrumentation } from '../../common/decorators/otel.decorator'

/** The jobs a snapshot hands out, and the only ones this settler answers for. */
const SNAPSHOT_JOB_TYPES: ReadonlySet<JobType> = new Set([JobType.CREATE_SNAPSHOT, JobType.RESTORE_SNAPSHOT])

export function isSnapshotJobType(jobType: JobType): boolean {
  return SNAPSHOT_JOB_TYPES.has(jobType)
}

/** What a finished CREATE_SNAPSHOT job reports: the archive's size in object storage. */
interface SnapshotArchiveResult {
  sizeBytes?: number
}

// One replica reconciles at a time; the TTL only bounds a replica that dies
// mid-tick.
const RECONCILE_LOCK_KEY = 'box-snapshot-reconcile'
const RECONCILE_LOCK_TTL_SECONDS = 60
const RECONCILE_BATCH = 100
// A live runner claims a job within seconds of it being queued, so one still
// unclaimed after as long as the stale sweep lets a claimed job stay silent
// (JobService.handleStaleJobs) has no runner coming for it.
const UNCLAIMED_JOB_TIMEOUT_MINUTES = 10

const FINISHED_JOB_STATUSES = [JobStatus.COMPLETED, JobStatus.FAILED]

/**
 * Ends snapshot operations when their runner jobs finish.
 *
 * Settling is one conditional transaction per job: it locks the box, then the
 * snapshot or restore the job belongs to, and acts only if that record is still
 * waiting. Delivering the same job twice therefore changes nothing the second
 * time, which is what lets the one-minute reconcile re-deliver any finished
 * job whose completion was lost without checking whether it already landed.
 *
 * Deleting a box mid-operation fails the operation even when its job finished
 * first: the deletion is what the caller asked for last, and a snapshot of a
 * box nobody wanted any more is not one to keep.
 */
@Injectable()
export class BoxSnapshotSettler {
  private readonly logger = new Logger(BoxSnapshotSettler.name)

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly boxRepository: BoxRepository,
    private readonly redisLockProvider: RedisLockProvider,
    @Inject(SNAPSHOT_ARCHIVE_STORE)
    private readonly archiveStore: SnapshotArchiveStore | null,
  ) {}

  async settle(job: Job): Promise<void> {
    if (!FINISHED_JOB_STATUSES.includes(job.status)) {
      return
    }
    if (job.type === JobType.CREATE_SNAPSHOT) {
      await this.settleExport(job)
    } else if (job.type === JobType.RESTORE_SNAPSHOT) {
      await this.settleRestore(job)
    }
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'box-snapshot-reconcile' })
  @LogExecution('box-snapshot-reconcile')
  @WithInstrumentation()
  async reconcile(): Promise<void> {
    if (!(await this.redisLockProvider.lock(RECONCILE_LOCK_KEY, RECONCILE_LOCK_TTL_SECONDS))) {
      return
    }
    try {
      await this.failUnclaimedJobs()
      await this.settleLostCompletions()
      await this.reapArchives()
    } catch (error) {
      this.logger.error('Error reconciling box snapshots', error)
    } finally {
      await this.redisLockProvider.unlock(RECONCILE_LOCK_KEY)
    }
  }

  private async settleExport(job: Job): Promise<void> {
    await this.dataSource.transaction(async (entityManager) => {
      const box = await this.lockBox(entityManager, job.resourceId)
      const snapshot = await entityManager.findOne(BoxSnapshot, {
        where: { jobId: job.id },
        lock: { mode: 'pessimistic_write' },
      })
      if (!snapshot || snapshot.state !== BoxSnapshotState.CREATING) {
        return
      }

      const deleted = !box || box.desiredState === BoxDesiredState.DESTROYED
      if (job.status === JobStatus.COMPLETED && !deleted) {
        await entityManager.update(
          BoxSnapshot,
          { id: snapshot.id },
          { state: BoxSnapshotState.READY, sizeBytes: this.archiveSize(job), errorReason: null },
        )
      } else {
        await entityManager.update(
          BoxSnapshot,
          { id: snapshot.id },
          {
            state: BoxSnapshotState.FAILED,
            errorReason: deleted ? 'The box was deleted while it was being exported' : this.failure(job, 'Export'),
          },
        )
      }
      await this.returnToStopped(entityManager, box, BoxState.EXPORTING)
    })
  }

  private async settleRestore(job: Job): Promise<void> {
    await this.dataSource.transaction(async (entityManager) => {
      const box = await this.lockBox(entityManager, job.resourceId)
      const restore = await entityManager.findOne(BoxSnapshotRestore, {
        where: { jobId: job.id },
        lock: { mode: 'pessimistic_write' },
      })
      if (!restore || restore.state !== BoxSnapshotRestoreState.PENDING) {
        return
      }

      const deleted = !box || box.desiredState === BoxDesiredState.DESTROYED
      const succeeded = job.status === JobStatus.COMPLETED && !deleted
      await entityManager.update(
        BoxSnapshotRestore,
        { id: restore.id },
        {
          state: succeeded ? BoxSnapshotRestoreState.SUCCEEDED : BoxSnapshotRestoreState.FAILED,
          errorReason: succeeded
            ? null
            : deleted
              ? 'The box was deleted while its disk was being restored'
              : this.failure(job, 'Restore'),
          completedAt: new Date(),
        },
      )
      // A failed restore leaves the original disk in place (the runtime swaps
      // it in one rename), so the box is as usable as before either way.
      await this.returnToStopped(entityManager, box, BoxState.IMPORTING)
    })
  }

  /**
   * Fail the snapshot jobs no runner has claimed in time. The sync loop leaves
   * a held box to its job, so a job whose runner is gone would otherwise hold
   * the box until the box is deleted. The status predicate makes this and a
   * late claim exclusive; settleLostCompletions then ends the operation.
   */
  private async failUnclaimedJobs(): Promise<void> {
    const now = new Date()
    await this.dataSource.getRepository(Job).update(
      {
        type: In([...SNAPSHOT_JOB_TYPES]),
        status: JobStatus.PENDING,
        createdAt: LessThan(new Date(now.getTime() - UNCLAIMED_JOB_TIMEOUT_MINUTES * 60 * 1000)),
      },
      {
        status: JobStatus.FAILED,
        errorMessage: `No runner picked up the job within ${UNCLAIMED_JOB_TIMEOUT_MINUTES} minutes`,
        completedAt: now,
      },
    )
  }

  /**
   * Re-deliver finished jobs whose operation is still waiting: the completion
   * hook is fire-and-forget, and a replica that dies between recording a job's
   * status and settling it would otherwise leave the box held for good.
   */
  private async settleLostCompletions(): Promise<void> {
    // Driven from the few waiting records, through their state indexes, and
    // then the job's primary key: the job table only grows, and scanning its
    // finished rows every minute would cost more each day.
    const jobs = await this.dataSource
      .getRepository(Job)
      .createQueryBuilder('job')
      .where(
        `job.id IN (SELECT s."jobId" FROM "box_snapshot" s WHERE s."state" = :creating AND s."jobId" IS NOT NULL
          UNION ALL SELECT r."jobId" FROM "box_snapshot_restore" r WHERE r."state" = :pending AND r."jobId" IS NOT NULL)`,
        { creating: BoxSnapshotState.CREATING, pending: BoxSnapshotRestoreState.PENDING },
      )
      .andWhere('job.status IN (:...finished)', { finished: FINISHED_JOB_STATUSES })
      .take(RECONCILE_BATCH)
      .getMany()

    for (const job of jobs) {
      await this.settle(job).catch((error) => this.logger.error(`Error settling snapshot job ${job.id}:`, error))
    }
  }

  /**
   * Delete the archive of every snapshot on its way out, then its row; and the
   * archive, if any, of every failed snapshot, whose row stays to say why.
   */
  private async reapArchives(): Promise<void> {
    if (!this.archiveStore) {
      return
    }
    const repository = this.dataSource.getRepository(BoxSnapshot)
    const snapshots = await repository.find({
      where: [{ state: BoxSnapshotState.DELETING }, { state: BoxSnapshotState.FAILED, archiveUri: Not('') }],
      take: RECONCILE_BATCH,
    })

    for (const snapshot of snapshots) {
      try {
        if (snapshot.archiveUri) {
          await this.archiveStore.delete(snapshot.archiveUri)
        }
        if (snapshot.state === BoxSnapshotState.DELETING) {
          await repository.delete({ id: snapshot.id, state: BoxSnapshotState.DELETING })
        } else {
          await repository.update({ id: snapshot.id, state: BoxSnapshotState.FAILED }, { archiveUri: '' })
        }
      } catch (error) {
        // Left for the next tick: the delete is idempotent.
        this.logger.error(`Error removing the archive of snapshot ${snapshot.id}:`, error)
      }
    }
  }

  private lockBox(entityManager: EntityManager, boxId: string): Promise<Box | null> {
    return entityManager.findOne(Box, {
      where: { id: boxId },
      lock: { mode: 'pessimistic_write' },
      loadEagerRelations: false,
    })
  }

  /** End the operation's hold on the box, unless a deletion has taken it over. */
  private async returnToStopped(
    entityManager: EntityManager,
    box: Box | null,
    state: BoxState.EXPORTING | BoxState.IMPORTING,
  ): Promise<void> {
    if (!box || box.state !== state || box.desiredState !== BoxDesiredState.STOPPED) {
      return
    }
    await this.boxRepository.updateWhere(
      box.id,
      { updateData: { state: BoxState.STOPPED }, whereCondition: { state, desiredState: BoxDesiredState.STOPPED } },
      entityManager,
    )
  }

  private archiveSize(job: Job): number {
    const sizeBytes = (job.getResultMetadata() as SnapshotArchiveResult | null)?.sizeBytes
    return Number.isSafeInteger(sizeBytes) && sizeBytes >= 0 ? sizeBytes : 0
  }

  private failure(job: Job, operation: string): string {
    return sanitizeBoxError(job.errorMessage ?? '').errorReason || `${operation} failed on the runner`
  }
}
