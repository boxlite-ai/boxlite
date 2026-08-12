/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource, EntityManager, FindOptionsWhere, IsNull, Not } from 'typeorm'
import { setTimeout } from 'timers/promises'

import { RedisLockProvider } from '../common/redis-lock.provider'
import { Box } from '../entities/box.entity'
import { BoxMigration } from '../entities/box-migration.entity'
import { BoxMigrationState } from '../enums/box-migration-state.enum'
import { JobType } from '../enums/job-type.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { JobService } from '../services/job.service'
import { RunnerService } from '../services/runner.service'
import { getMigrateJobLockKey } from '../utils/lock-key.util'

import { LogExecution } from '../../common/decorators/log-execution.decorator'
import { WithInstrumentation } from '../../common/decorators/otel.decorator'
import { TrackJobExecution } from '../../common/decorators/track-job-execution.decorator'
import { TrackableJobExecutions } from '../../common/interfaces/trackable-job-executions'
import { TypedConfigService } from '../../config/typed-config.service'

// Only one API replica sweeps at a time; the TTL only bounds a replica that
// dies mid-tick, since the happy path unlocks in `finally`.
const SUBMIT_LOOP_LOCK_KEY = 'box-migration-submit-worker-selected'
const ROLLBACK_LOOP_LOCK_KEY = 'box-migration-rollback-worker-selected'
const LOOP_LOCK_TTL_SECONDS = 60

// A migration job's lock outlives the tick that took it — the receiver of the
// job status releases it. This TTL is the backstop for a status that never
// arrives, so it has to outlast the job table's own stale sweep (10 minutes,
// JobService.handleStaleJobs); otherwise the lock would expire and a second job
// would be submitted while the runner is still working on the first.
const MIGRATE_JOB_LOCK_TTL_SECONDS = 15 * 60

const MIGRATIONS_PER_TICK = 100

/** Mirrors the runner's MigrateArchivePayload (executor/types.go). */
interface MigrateArchivePayload {
  arcPath: string
}

interface MigrateJobTarget {
  runnerId: string
  payload?: MigrateArchivePayload
}

/**
 * Drives the two migration loops of the control plane.
 *
 * Submitter (10s) hands a migration its next job — export, then import — each
 * guarded by ValidCheck, which is what catches a user touching the box
 * mid-flight and turns the migration around.
 *
 * RollBackSubmitter (60s) hands out the jobs that reclaim what a migration
 * left behind: the archive on the object store, the box on the other runner.
 *
 * Neither loop advances the migration's state on success — the receiver of the
 * job status does, so a state only moves once the work behind it is done.
 */
@Injectable()
export class BoxMigrationManager implements TrackableJobExecutions, OnApplicationShutdown {
  activeJobs = new Set<string>()

  private readonly logger = new Logger(BoxMigrationManager.name)

  /** Read once: the prefix is validated at boot and fixed for the process. */
  private readonly archivePrefix: string

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly runnerService: RunnerService,
    private readonly jobService: JobService,
    private readonly redisLockProvider: RedisLockProvider,
    configService: TypedConfigService,
  ) {
    this.archivePrefix = configService.getOrThrow('boxMigration.archivePrefix')
  }

  async onApplicationShutdown() {
    //  wait for all active jobs to finish
    while (this.activeJobs.size > 0) {
      this.logger.log(`Waiting for ${this.activeJobs.size} active jobs to finish`)
      await setTimeout(1000)
    }
  }

  /**
   * center-Submitter Loop — submit the job each waiting migration is named for.
   */
  @Cron(CronExpression.EVERY_10_SECONDS, { name: 'box-migration-submit' })
  @TrackJobExecution()
  @WithInstrumentation()
  @LogExecution('box-migration-submit')
  async submitMigrationJobs(): Promise<void> {
    if (!(await this.redisLockProvider.lock(SUBMIT_LOOP_LOCK_KEY, LOOP_LOCK_TTL_SECONDS))) {
      return
    }

    try {
      const migrations = await this.findMigrations([
        { state: BoxMigrationState.PENDING_EXPORT },
        { state: BoxMigrationState.PENDING_IMPORT },
      ])

      await Promise.all(
        migrations.map((migration) =>
          migration.state === BoxMigrationState.PENDING_EXPORT
            ? this.submitExport(migration)
            : this.submitImport(migration),
        ),
      )
    } finally {
      await this.redisLockProvider.unlock(SUBMIT_LOOP_LOCK_KEY)
    }
  }

  /**
   * center-RollBackSubmitter Loop — reclaim what a migration left behind, and
   * discard the exported box once the migration has committed.
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'box-migration-rollback-submit' })
  @TrackJobExecution()
  @WithInstrumentation()
  @LogExecution('box-migration-rollback-submit')
  async submitRollbackJobs(): Promise<void> {
    if (!(await this.redisLockProvider.lock(ROLLBACK_LOOP_LOCK_KEY, LOOP_LOCK_TTL_SECONDS))) {
      return
    }

    try {
      const migrations = await this.findMigrations([
        { state: BoxMigrationState.PENDING_ROLLBACK },
        // A discard is only pending while there is still something to discard;
        // its receiver clears both fields when the job succeeds.
        { state: BoxMigrationState.PENDING_DISCARD_EXPORTED, arcPath: Not('') },
        { state: BoxMigrationState.PENDING_DISCARD_EXPORTED, runnerId: Not(IsNull()) },
      ])

      await Promise.all(
        migrations.map((migration) =>
          migration.state === BoxMigrationState.PENDING_ROLLBACK
            ? this.reclaim(migration)
            : this.discardExported(migration),
        ),
      )
    } finally {
      await this.redisLockProvider.unlock(ROLLBACK_LOOP_LOCK_KEY)
    }
  }

  /**
   * Migrations matching any of the given conditions, most recently used box
   * first, each with the box it moves.
   *
   * `box_migration.updatedAt` is the copy of `box.updatedAt` the migration
   * took, so ordering by it descending serves the boxes a user touched last
   * before the ones parked longest. Those are the boxes most likely to be
   * started again, and starting one on a draining runner both loses the
   * migration to ValidCheck and puts the box back on a runner about to go away.
   *
   * A row whose box did not load is skipped: the foreign key cascades, so the
   * box outlives every migration on it and a missing one is a broken row rather
   * than a box that went away.
   */
  private async findMigrations(where: FindOptionsWhere<BoxMigration>[]): Promise<BoxMigration[]> {
    const migrations = await this.dataSource.getRepository(BoxMigration).find({
      where,
      relations: { box: true },
      order: { updatedAt: 'DESC' },
      take: MIGRATIONS_PER_TICK,
      loadEagerRelations: false,
    })

    return migrations.filter((migration) => {
      if (!migration.box) {
        this.logger.error(`Migration of box ${migration.boxId} has no box row`)
        return false
      }
      return true
    })
  }

  /**
   * The object store key this migration moves the box through. Derived from the
   * box so a retried export overwrites its own archive instead of stranding one:
   * a box has at most one migration in flight — one `box_migration` row — and the
   * key is dropped once that migration commits or rolls back.
   *
   * Only the export leg derives a key; every leg after it acts on the one the
   * export reported, so the configured prefix may change under a migration
   * already in flight without stranding its archive.
   */
  private migrateArcPath(boxId: string): string {
    return `${this.archivePrefix}${boxId}.boxlite`
  }

  /**
   * EXPORT_BOX — pack the box and put its archive on the object store.
   *
   * Submitted while the migration sits in PENDING_EXPORT: the state the marker
   * writes the minute it claims a parked box off a draining runner, and the state
   * the migration keeps until the export's receiver records an archive. Every 10s
   * tick in between calls this again, and what happens then is the job lock's
   * doing — a held lock means the runner is still working on the job this already
   * submitted, while a submission that threw is retried by the tick after it. A
   * failed ValidCheck is the one outcome not retried: it turns the migration
   * around instead of exporting.
   *
   * The job goes to the runner still holding the box, which is the draining one:
   * the archive can only be made where the box is.
   */
  private async submitExport(migration: BoxMigration): Promise<void> {
    if (!migration.box.runnerId) {
      // Invalid job, skipped
      this.logger.error(`Box ${migration.boxId} is waiting to be exported but has no runner`)
      return
    }

    await this.submitValidated(migration, JobType.EXPORT_BOX, async (box) => ({
      runnerId: box.runnerId,
      payload: { arcPath: this.migrateArcPath(box.id) },
    }))
  }

  /**
   * IMPORT_BOX — restore the box from its archive onto a second runner.
   *
   * Submitted while the migration sits in PENDING_IMPORT, the state the export's
   * receiver writes together with the archive key it reported. Like the export it
   * is retried each 10s tick until a receiver moves the state on, and the whole
   * import — not just its first attempt — happens after the export has finished,
   * because nothing puts a migration into this state until then.
   */
  private async submitImport(migration: BoxMigration): Promise<void> {
    if (!migration.arcPath) {
      // Nothing to import from — the export leg never recorded an archive, so
      // this migration cannot finish. Rollback finds no artifact to reclaim and
      // drops the row, leaving the box for the Marker to claim again.
      this.logger.error(`Box ${migration.boxId} is waiting to be imported but has no archive; rolling back`)
      await this.markRollback(this.dataSource.manager, migration)
      return
    }

    await this.submitValidated(migration, JobType.IMPORT_BOX, async (box, validated) => {
      const target = await this.runnerService.getRandomAvailableRunner({
        regions: [box.region],
        boxClass: box.class,
        excludedRunnerIds: [box.runnerId],
      })
      return {
        runnerId: target.id,
        payload: { arcPath: validated.arcPath },
      }
    })
  }

  /**
   * Take the job's lock, ValidCheck, submit — the shape both legs share.
   *
   * The lock is what says "this job is in flight", so it is kept on success and
   * released by the receiver of the job status. Everything else — a lost race,
   * a failed ValidCheck, a submission that threw — releases it here and leaves
   * the migration's state for the next tick to retry.
   *
   * The box row is locked, not the `box_migration` row it names: `box.updatedAt`
   * is the side of the equality that anyone may move, so holding the box is what
   * stops a write landing between the check and the job. The `box_migration` row
   * is re-read under that same lock, in the order the marker takes them.
   */
  private async submitValidated(
    migration: BoxMigration,
    jobType: JobType,
    resolveTarget: (box: Box, migration: BoxMigration) => Promise<MigrateJobTarget>,
  ): Promise<void> {
    const lockKey = getMigrateJobLockKey(migration.boxId, jobType)
    if (!(await this.redisLockProvider.lock(lockKey, MIGRATE_JOB_LOCK_TTL_SECONDS))) {
      return
    }

    let submitted = false
    try {
      submitted = await this.dataSource.transaction(async (entityManager) => {
        const box = await entityManager.findOne(Box, {
          where: { id: migration.boxId },
          lock: { mode: 'pessimistic_write' },
          loadEagerRelations: false,
        })
        const current = await entityManager.findOne(BoxMigration, {
          where: { boxId: migration.boxId },
          lock: { mode: 'pessimistic_write' },
          loadEagerRelations: false,
        })

        if (!box || !current || current.state !== migration.state) {
          return false
        }

        if (!current.isUndisturbedBy(box)) {
          this.logger.log(`Box ${box.id} was touched during its migration; rolling back instead of ${jobType}`)
          await this.markRollback(entityManager, current)
          return false
        }

        const target = await resolveTarget(box, current)
        await this.jobService.createJob(
          entityManager,
          jobType,
          target.runnerId,
          ResourceType.BOX,
          box.id,
          target.payload,
        )

        this.logger.log(`Submitted ${jobType} for box ${box.id} to runner ${target.runnerId}`)
        return true
      })
    } catch (error) {
      this.logger.error(`Error submitting ${jobType} for box ${migration.boxId}:`, error)
    } finally {
      if (!submitted) {
        await this.redisLockProvider.unlock(lockKey)
      }
    }
  }

  /**
   * Reclaim whatever a turned-around migration left behind. Both artifacts can
   * be outstanding at once — an import that succeeded and then failed
   * ValidCheck leaves an archive on the object store and a box on the target
   * runner — and each is reclaimed by its own job on its own runner.
   */
  private async reclaim(migration: BoxMigration): Promise<void> {
    if (!migration.arcPath && !migration.runnerId) {
      await this.finishRollback(migration)
      return
    }

    if (migration.arcPath) {
      await this.submitReclaimJob(migration, JobType.ROLLBACK_EXPORT_BOX, migration.box.runnerId, {
        arcPath: migration.arcPath,
      })
    }

    if (migration.runnerId) {
      await this.submitReclaimJob(migration, JobType.ROLLBACK_IMPORT_BOX, migration.runnerId)
    }
  }

  /**
   * Discard the box the migration moved away from, along with the archive it
   * travelled in. Runs after the commit point, so the migration's `runnerId` is
   * the runner that gave the box up.
   */
  private async discardExported(migration: BoxMigration): Promise<void> {
    if (!migration.runnerId || !migration.arcPath) {
      // Both fields are written at the commit point and cleared together when
      // the discard succeeds, so only an inconsistent row lands here — and a
      // discard job without them cannot do its work.
      this.logger.error(
        `Box ${migration.boxId} cannot have its exported copy discarded: runner=${migration.runnerId ?? 'none'} archive=${migration.arcPath || 'none'}`,
      )
      return
    }

    await this.submitReclaimJob(migration, JobType.DISCARD_EXPORTED_BOX, migration.runnerId, {
      arcPath: migration.arcPath,
    })
  }

  /**
   * Submit a job that reclaims an artifact. Unlike the two validated legs there
   * is nothing to check: the artifact fields say the artifact exists, and the
   * receiver clears the field the job reclaimed.
   *
   * Reached from the 60s loop for a migration whose state names cleanup —
   * PENDING_ROLLBACK once ValidCheck turned the migration around, or
   * PENDING_DISCARD_EXPORTED once it is past its commit point — and only for the
   * artifacts that row still names, so a rollback carrying both an archive and an
   * imported box submits one job per artifact in the same tick. Each keeps its own
   * per-box-per-job lock until its receiver releases it, which is what stops the
   * next tick from re-submitting a reclaim already running.
   */
  private async submitReclaimJob(
    migration: BoxMigration,
    jobType: JobType,
    runnerId: string | undefined,
    payload?: MigrateArchivePayload,
  ): Promise<void> {
    if (!runnerId) {
      this.logger.error(`Box ${migration.boxId} needs ${jobType} but the runner to run it on is unknown`)
      return
    }

    const lockKey = getMigrateJobLockKey(migration.boxId, jobType)
    if (!(await this.redisLockProvider.lock(lockKey, MIGRATE_JOB_LOCK_TTL_SECONDS))) {
      return
    }

    try {
      await this.jobService.createJob(null, jobType, runnerId, ResourceType.BOX, migration.boxId, payload)
      this.logger.log(`Submitted ${jobType} for box ${migration.boxId} to runner ${runnerId}`)
    } catch (error) {
      this.logger.error(`Error submitting ${jobType} for box ${migration.boxId}:`, error)
      await this.redisLockProvider.unlock(lockKey)
    }
  }

  /** Turn the migration around; the artifact fields drive the reclaim from here. */
  private async markRollback(entityManager: EntityManager, migration: BoxMigration): Promise<void> {
    await entityManager
      .createQueryBuilder()
      .update(BoxMigration)
      .set({ state: BoxMigrationState.PENDING_ROLLBACK })
      .where('"boxId" = :boxId', { boxId: migration.boxId })
      .andWhere('"state" = :expected', { expected: migration.state })
      .execute()
  }

  /**
   * Nothing left to reclaim — the box is as it was before the migration, so the
   * migration stops existing. Conditional on the state we read, so a receiver
   * that moved the migration on between the scan and this write keeps its row.
   */
  private async finishRollback(migration: BoxMigration): Promise<void> {
    await this.dataSource.manager
      .createQueryBuilder()
      .delete()
      .from(BoxMigration)
      .where('"boxId" = :boxId', { boxId: migration.boxId })
      .andWhere('"state" = :expected', { expected: migration.state })
      .execute()

    this.logger.log(`Rollback complete for box ${migration.boxId}`)
  }
}
