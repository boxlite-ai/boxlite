/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource, EntityManager } from 'typeorm'

import { RedisLockProvider } from '../common/redis-lock.provider'
import { Box } from '../entities/box.entity'
import { BoxMigration } from '../entities/box-migration.entity'
import { Job } from '../entities/job.entity'
import { BoxMigrationState } from '../enums/box-migration-state.enum'
import { JobStatus } from '../enums/job-status.enum'
import { JobType } from '../enums/job-type.enum'
import { BoxLookupCacheInvalidationService } from './box-lookup-cache-invalidation.service'
import { getMigrateJobLockKey } from '../utils/lock-key.util'

/** The jobs a migration hands out, and the only ones this receiver answers for. */
const MIGRATION_JOB_TYPES: ReadonlySet<JobType> = new Set([
  JobType.EXPORT_BOX,
  JobType.IMPORT_BOX,
  JobType.ROLLBACK_EXPORT_BOX,
  JobType.ROLLBACK_IMPORT_BOX,
  JobType.DISCARD_EXPORTED_BOX,
])

export function isMigrationJobType(jobType: JobType): boolean {
  return MIGRATION_JOB_TYPES.has(jobType)
}

/** Mirrors the runner's MigrateArchiveResult and MigrateArchivePayload (executor/types.go). */
interface MigrateArchive {
  arcPath?: string
}

/**
 * The migrate columns this receiver writes. `updatedAt` is not among them: it
 * is the copy of `box.updatedAt` the marker took, and only the marker takes it.
 * `runnerId` is cleared with a real NULL rather than dropped from the write,
 * which is how the loops read "no such box exists".
 */
type MigrationWrite = Partial<Pick<BoxMigration, 'state' | 'arcPath'>> & { runnerId?: string | null }

/** What the two validated legs need to decide, read under the box's row lock. */
interface ValidatedMigration {
  entityManager: EntityManager
  box: Box
  //  ValidCheck: nothing outside the migration has touched the box since it was
  //  claimed, so the migration may still move it.
  undisturbed: boolean
}

/**
 * center-jobReceiver — advances a migration when the runner reports what it did.
 *
 * A migration state names the job the box is waiting on, so only this receiver
 * moves it: the state changes once the work behind it is done, never when the
 * job is handed out. Every write is conditional on the state the job was
 * submitted from, so a status redelivered after a restart matches nothing and
 * applies once.
 *
 * The two legs that move real data — export and import — re-run ValidCheck in
 * the transaction that records their result, because the box may have been
 * started while the runner was working. That turns the migration around rather
 * than failing it: the artifact is recorded either way, since it exists either
 * way and the rollback path needs the field to reclaim it.
 *
 * Job failure is not this receiver's to repair. The state stays where it is,
 * the job's lock is released, and the loop that submitted it retries.
 */
@Injectable()
export class BoxMigrationJobReceiver {
  private readonly logger = new Logger(BoxMigrationJobReceiver.name)

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly redisLockProvider: RedisLockProvider,
    private readonly boxLookupCacheInvalidationService: BoxLookupCacheInvalidationService,
  ) {}

  /**
   * Apply a finished migration job to the migration that submitted it.
   *
   * The job's lock is released whatever happened, because the lock is what says
   * "this job is in flight" — holding it after the job ended would park the
   * migration until the lock's TTL ran out.
   */
  async handleJobCompletion(job: Job): Promise<void> {
    try {
      if (job.status === JobStatus.COMPLETED) {
        await this.applySuccess(job)
      } else {
        // Left where it is on purpose: the submitting loop reads the state to
        // decide what to retry, and the job's own artifacts are unchanged.
        this.logger.error(`${job.type} failed for box ${job.resourceId}: ${job.errorMessage ?? 'no error reported'}`)
      }
    } catch (error) {
      this.logger.error(`Error applying ${job.type} for box ${job.resourceId}:`, error)
    } finally {
      await this.releaseJobLock(job)
    }
  }

  private async applySuccess(job: Job): Promise<void> {
    switch (job.type) {
      case JobType.EXPORT_BOX:
        return this.receiveExport(job)
      case JobType.IMPORT_BOX:
        return this.receiveImport(job)
      case JobType.ROLLBACK_EXPORT_BOX:
        return this.receiveRollbackExport(job)
      case JobType.ROLLBACK_IMPORT_BOX:
        return this.receiveRollbackImport(job)
      case JobType.DISCARD_EXPORTED_BOX:
        return this.receiveDiscardExported(job)
      default:
        this.logger.error(`${job.type} is not a migration job but reached the migration receiver`)
    }
  }

  /**
   * The archive is on the object store — record where, and move on to the import
   * if the box is still the migration's to move.
   */
  private async receiveExport(job: Job): Promise<void> {
    const arcPath = this.exportedArcPath(job)
    if (!arcPath) {
      // Recorded as an empty key, which reads as "no archive to reclaim". The
      // import leg finds nothing to import from and turns the migration around.
      this.logger.error(`EXPORT_BOX for box ${job.resourceId} was submitted with no archive key`)
    }

    await this.withMigration(job, BoxMigrationState.PENDING_EXPORT, async ({ entityManager, box, undisturbed }) => {
      if (!undisturbed) {
        this.logger.log(`Box ${box.id} was touched while it was exported; rolling back instead of importing`)
      }

      await this.updateMigration(entityManager, box.id, BoxMigrationState.PENDING_EXPORT, {
        state: undisturbed ? BoxMigrationState.PENDING_IMPORT : BoxMigrationState.PENDING_ROLLBACK,
        arcPath,
      })
    })
  }

  /**
   * The box now exists on the target runner. If it is still the migration's to
   * move, this is the commit point: ownership moves in the same transaction that
   * checks it, and what was the box's runner becomes the copy left to discard.
   */
  private async receiveImport(job: Job): Promise<void> {
    //  The target runner is the runner this job was submitted to, so the runner
    //  never has to report where it put the box.
    const targetRunnerId = job.runnerId

    const moved = await this.withMigration(
      job,
      BoxMigrationState.PENDING_IMPORT,
      async ({ entityManager, box, undisturbed }) => {
        //  A box with no runner has nothing to migrate away from, and moving
        //  ownership anyway would leave a discard that nothing can run. The
        //  marker only claims a box on a runner, so ValidCheck already rules
        //  this out; it is here because the alternative is a stuck migration.
        const sourceRunnerId = box.runnerId
        if (!sourceRunnerId) {
          this.logger.error(`Box ${box.id} was imported onto runner ${targetRunnerId} but has no runner of its own`)
        } else if (!undisturbed) {
          this.logger.log(`Box ${box.id} was touched while it was imported; rolling back the copy on ${targetRunnerId}`)
        }

        if (!sourceRunnerId || !undisturbed) {
          //  The copy on the target runner is what rollback reclaims.
          await this.updateMigration(entityManager, box.id, BoxMigrationState.PENDING_IMPORT, {
            state: BoxMigrationState.PENDING_ROLLBACK,
            runnerId: targetRunnerId,
          })
          return null
        }

        //  Neither row is stamped. `migrate.updatedAt` is the copy ValidCheck
        //  compares against, and this is the last step that reads it: past the
        //  commit point the migration only discards what it left behind, and a
        //  re-drain re-copies the box's own `updatedAt` when it claims the row.
        await entityManager
          .createQueryBuilder()
          .update(Box)
          .set({ runnerId: targetRunnerId })
          .where('id = :id', { id: box.id })
          .execute()

        await this.updateMigration(entityManager, box.id, BoxMigrationState.PENDING_IMPORT, {
          state: BoxMigrationState.PENDING_DISCARD_EXPORTED,
          runnerId: sourceRunnerId,
        })

        this.logger.log(`Box ${box.id} moved from runner ${sourceRunnerId} to runner ${targetRunnerId}`)
        return box
      },
    )

    if (moved) {
      //  The cached box still names the runner that no longer serves it.
      this.boxLookupCacheInvalidationService.invalidate({
        id: moved.id,
        organizationId: moved.organizationId,
        name: moved.name,
      })
    }
  }

  /** The archive a turned-around migration left on the object store is gone. */
  private async receiveRollbackExport(job: Job): Promise<void> {
    await this.updateMigration(this.dataSource.manager, job.resourceId, BoxMigrationState.PENDING_ROLLBACK, {
      arcPath: '',
    })
  }

  /** The copy a turned-around migration left on the target runner is gone. */
  private async receiveRollbackImport(job: Job): Promise<void> {
    await this.updateMigration(this.dataSource.manager, job.resourceId, BoxMigrationState.PENDING_ROLLBACK, {
      runnerId: null,
    })
  }

  /**
   * The box the migration moved away from, and the archive it travelled in, are
   * both gone: nothing of the migration is outstanding any more.
   */
  private async receiveDiscardExported(job: Job): Promise<void> {
    const applied = await this.updateMigration(
      this.dataSource.manager,
      job.resourceId,
      BoxMigrationState.PENDING_DISCARD_EXPORTED,
      {
        state: BoxMigrationState.COMPLETED,
        arcPath: '',
        runnerId: null,
      },
    )

    if (applied) {
      this.logger.log(`Migration of box ${job.resourceId} completed`)
    }
  }

  /**
   * Run `apply` against the box and its migration, both held for the length of
   * the transaction, with the verdict of ValidCheck.
   *
   * The box row is locked first and the migrate row second — the order the
   * marker and the submitter take them — so the three never deadlock against
   * each other. Locking the box is what makes ValidCheck mean anything: it is
   * `box.updatedAt` that anyone may move, so holding the box row is what stops a
   * write landing between the check and the write it guards.
   */
  private async withMigration<T>(
    job: Job,
    expected: BoxMigrationState,
    apply: (validated: ValidatedMigration) => Promise<T>,
  ): Promise<T | null> {
    return this.dataSource.transaction(async (entityManager) => {
      const box = await entityManager.findOne(Box, {
        where: { id: job.resourceId },
        lock: { mode: 'pessimistic_write' },
        loadEagerRelations: false,
      })
      const migration = await entityManager.findOne(BoxMigration, {
        where: { boxId: job.resourceId },
        lock: { mode: 'pessimistic_write' },
        loadEagerRelations: false,
      })

      if (!box || !migration) {
        this.logger.warn(`${job.type} for box ${job.resourceId} has no ${box ? 'migration' : 'box'} left to apply to`)
        return null
      }

      if (migration.state !== expected) {
        //  Either this status was redelivered after the migration moved on, or
        //  the migration was turned around while the runner was working.
        this.logger.warn(
          `${job.type} for box ${job.resourceId} arrived in ${migration.state}, not ${expected}; ignoring it`,
        )
        return null
      }

      return apply({ entityManager, box, undisturbed: migration.isUndisturbedBy(box) })
    })
  }

  /**
   * The only way this receiver writes a migration: conditional on the state the
   * job was submitted from, so applying the same status twice is a no-op.
   */
  private async updateMigration(
    entityManager: EntityManager,
    boxId: string,
    expected: BoxMigrationState,
    values: MigrationWrite,
  ): Promise<boolean> {
    const result = await entityManager
      .createQueryBuilder()
      .update(BoxMigration)
      .set(values)
      .where('"boxId" = :boxId', { boxId })
      .andWhere('"state" = :expected', { expected })
      .execute()

    const applied = result.affected > 0
    if (!applied) {
      this.logger.warn(`Box ${boxId} has no migration in ${expected} to apply this job status to`)
    }
    return applied
  }

  /**
   * The key the archive was uploaded under: the one the control plane assigned
   * in the job's payload, never the one the runner echoes back. What is recorded
   * here is handed to a *different* runner to download and to delete, so a
   * reported key would let one runner name another's object as the thing to
   * remove. The echo is only worth comparing: a mismatch means the runner wrote
   * somewhere the migration will never reclaim.
   */
  private exportedArcPath(job: Job): string {
    const assigned = job.getPayload<MigrateArchive>()?.arcPath ?? ''
    const reported = (job.getResultMetadata() as MigrateArchive | null)?.arcPath
    if (reported && reported !== assigned) {
      this.logger.error(
        `EXPORT_BOX for box ${job.resourceId} reported archive key ${reported}, not the assigned ${assigned || 'none'}`,
      )
    }
    return assigned
  }

  private async releaseJobLock(job: Job): Promise<void> {
    const lockKey = getMigrateJobLockKey(job.resourceId, job.type)
    try {
      await this.redisLockProvider.unlock(lockKey)
    } catch (error) {
      //  The lock's TTL outlasts the job table's stale sweep, so a lock left
      //  behind here delays the next attempt rather than losing the migration.
      this.logger.error(`Error releasing ${lockKey}:`, error)
    }
  }
}
