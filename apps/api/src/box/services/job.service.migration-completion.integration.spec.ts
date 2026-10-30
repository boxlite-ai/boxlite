/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import { ConflictException } from '@nestjs/common'
import { DataSource, Logger as DatabaseLogger } from 'typeorm'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { Box } from '../entities/box.entity'
import { BoxLastActivity } from '../entities/box-last-activity.entity'
import { BoxMigration } from '../entities/box-migration.entity'
import { Job } from '../entities/job.entity'
import { Runner } from '../entities/runner.entity'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxMigrationState } from '../enums/box-migration-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { JobStatus } from '../enums/job-status.enum'
import { JobType } from '../enums/job-type.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { BoxMigrationJobReceiver } from './box-migration-job-receiver.service'
import { JobStateHandlerService } from './job-state-handler.service'
import { JobService } from './job.service'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schema = `migration_completion_${process.pid}_${randomUUID().replaceAll('-', '')}`
const applicationName = schema
const sourceRunner = '00000000-0000-4000-8000-00000000000a'
const targetRunner = '00000000-0000-4000-8000-00000000000b'
const organization = '00000000-0000-4000-8000-0000000000ff'
const deadlineMs = 10_000

async function bounded<T>(promise: Promise<T>, operation: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Reproducer timed out: ${operation}`)), deadlineMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

describeIfDatabase('Migration completion atomicity (integration, real Postgres)', () => {
  let database: DataSource
  let observer: DataSource
  let ownsSchema = false
  const databaseErrors: string[] = []

  const logger: DatabaseLogger = {
    logQuery() {},
    logQueryError(error) {
      databaseErrors.push(
        typeof error === 'string' ? error : ((error as Error & { code?: string }).code ?? error.message),
      )
    },
    logQuerySlow() {},
    logSchemaBuild() {},
    logMigration() {},
    log() {},
  }

  beforeAll(async () => {
    const connection = {
      type: 'postgres' as const,
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
    }
    observer = await new DataSource({ ...connection, extra: { max: 2 } }).initialize()
    await observer.query(`CREATE SCHEMA "${schema}"`)
    ownsSchema = true
    database = await new DataSource({
      ...connection,
      schema,
      entities: [Box, BoxLastActivity, BoxMigration, Job, Runner],
      namingStrategy: new CustomNamingStrategy(),
      entitySkipConstructor: true,
      synchronize: false,
      logger,
      extra: {
        max: 2,
        application_name: applicationName,
        options: `-c search_path=${schema},public`,
      },
    }).initialize()
    await database.synchronize()
  }, 30_000)

  afterAll(async () => {
    try {
      if (database?.isInitialized) await database.destroy()
      if (ownsSchema) await observer.query(`DROP SCHEMA "${schema}" CASCADE`)
    } finally {
      if (observer?.isInitialized) await observer.destroy()
    }
  })

  beforeEach(async () => {
    for (const table of ['job', 'box_migration', 'box_last_activity', 'box', 'runner']) {
      await observer.query(`DELETE FROM "${schema}"."${table}"`)
    }
    databaseErrors.length = 0
  })

  async function pendingJob(type = JobType.IMPORT_BOX, state = BoxMigrationState.PENDING_IMPORT): Promise<Job> {
    const runner = new Runner({ region: 'us', name: 'source', apiKey: 'fixture', apiVersion: '1' })
    runner.id = sourceRunner
    runner.draining = true
    await database.getRepository(Runner).insert(runner)
    const box = new Box('us', 'migration-completion')
    box.organizationId = organization
    box.osUser = 'boxlite'
    box.runnerId = state === BoxMigrationState.PENDING_DISCARD_EXPORTED ? targetRunner : sourceRunner
    box.state = BoxState.STOPPED
    box.desiredState = BoxDesiredState.STOPPED
    box.pending = false
    await database.getRepository(Box).insert(box)

    const stored = await database.getRepository(Box).findOneByOrFail({ id: box.id })
    const migration = new BoxMigration()
    migration.boxId = stored.id
    migration.state = state
    const arcPath = `box-migrations/${stored.id}.boxlite`
    migration.arcPath = state === BoxMigrationState.PENDING_EXPORT ? '' : arcPath
    migration.runnerId =
      state === BoxMigrationState.PENDING_ROLLBACK
        ? targetRunner
        : state === BoxMigrationState.PENDING_DISCARD_EXPORTED
          ? sourceRunner
          : null
    migration.updatedAt = stored.updatedAt
    expect(migration.isUndisturbedBy(stored)).toBe(true)
    await database.getRepository(BoxMigration).insert(migration)

    const job = new Job({
      type,
      status: JobStatus.IN_PROGRESS,
      runnerId: type === JobType.IMPORT_BOX || type === JobType.ROLLBACK_IMPORT_BOX ? targetRunner : sourceRunner,
      resourceType: ResourceType.BACKUP,
      resourceId: stored.id,
      payload: JSON.stringify({ arcPath }),
      startedAt: new Date(),
    })
    await database.getRepository(Job).insert(job)
    return job
  }

  function services() {
    const locks = { unlock: jest.fn().mockResolvedValue(undefined) }
    const cache = { invalidate: jest.fn() }
    const receiver = new BoxMigrationJobReceiver(locks as never, cache as never)
    const completions: Promise<unknown>[] = []
    const original = receiver.handleJobCompletion.bind(receiver)
    // Observe the real background task's lifetime without changing its result.
    jest.spyOn(receiver, 'handleJobCompletion').mockImplementation((...args) => {
      const completion = original(...args)
      completions.push(completion)
      return completion
    })
    const handler = new JobStateHandlerService(undefined as never, locks as never, undefined as never)
    return {
      service: new JobService(database.getRepository(Job), {} as never, handler, receiver),
      completions,
      locks,
      cache,
    }
  }

  async function snapshot(job: Job) {
    // One statement on a separate connection observes one committed snapshot.
    const [row] = await observer.query(
      `SELECT j.status AS "jobStatus", j."completedAt", j."resultMetadata", j."errorMessage", j.version,
              b."runnerId" AS "boxRunnerId", m.state AS "migrationState",
              m."runnerId" AS "migrationRunnerId", m."arcPath"
         FROM "${schema}".job j
         JOIN "${schema}".box b ON b.id = j."resourceId"
         LEFT JOIN "${schema}".box_migration m ON m."boxId" = b.id
        WHERE j.id = $1`,
      [job.id],
    )
    return row
  }

  async function blockedBackend(blockerPid: number): Promise<number> {
    const deadline = Date.now() + deadlineMs
    while (Date.now() < deadline) {
      const rows = await observer.query(
        `SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND application_name = $1
            AND $2 = ANY(pg_blocking_pids(pid))`,
        [applicationName, blockerPid],
      )
      if (rows.length === 1) return rows[0].pid
      if (rows.length > 1) throw new Error('Reproducer found multiple blocked application backends')
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
    }
    throw new Error('Reproducer never reached the migration row-lock barrier')
  }

  it(
    'commits an ordinary import completion through the real services',
    async () => {
      const job = await pendingJob()
      const { service, completions, locks, cache } = services()
      const released: unknown[] = []
      locks.unlock.mockImplementation(async () => {
        released.push(await snapshot(job))
      })
      await bounded(service.updateJobStatus(job.id, JobStatus.COMPLETED), 'normal completion')
      expect(completions).toHaveLength(1)
      await bounded(Promise.all(completions), 'normal receiver')
      const observed = await snapshot(job)
      expect(observed).toMatchObject({
        jobStatus: JobStatus.COMPLETED,
        boxRunnerId: targetRunner,
        migrationState: BoxMigrationState.PENDING_DISCARD_EXPORTED,
        migrationRunnerId: sourceRunner,
      })
      expect(observed.completedAt).not.toBeNull()
      expect(databaseErrors).toEqual([])
      expect(locks.unlock).toHaveBeenCalledTimes(1)
      expect(cache.invalidate).toHaveBeenCalledTimes(1)
      await bounded(locks.unlock.mock.results[0].value, 'committed unlock')
      expect(released).toEqual([observed])
    },
    deadlineMs * 3,
  )

  it(
    'returns the committed result while Redis unlock is stalled',
    async () => {
      const job = await pendingJob()
      const { service, locks } = services()
      let finishUnlock!: () => void
      let startUnlock!: () => void
      const started = new Promise<void>((resolve) => {
        startUnlock = resolve
      })
      const stalled = new Promise<void>((resolve) => {
        finishUnlock = resolve
      })
      locks.unlock.mockImplementation(() => {
        startUnlock()
        return stalled
      })
      const reported = service.updateJobStatus(job.id, JobStatus.COMPLETED)
      try {
        await bounded(started, 'Redis unlock started')
        const result = await bounded(reported, 'completion while Redis unlock is stalled')
        expect(result.status).toBe(JobStatus.COMPLETED)
        expect(locks.unlock).toHaveBeenCalledTimes(1)
        expect(await snapshot(job)).toMatchObject({
          jobStatus: JobStatus.COMPLETED,
          boxRunnerId: targetRunner,
          migrationState: BoxMigrationState.PENDING_DISCARD_EXPORTED,
        })
      } finally {
        finishUnlock()
        await bounded(reported, 'stalled unlock cleanup')
      }
    },
    deadlineMs * 3,
  )

  it.each([
    [JobType.IMPORT_BOX, JobStatus.COMPLETED, BoxMigrationState.PENDING_IMPORT],
    [JobType.EXPORT_BOX, JobStatus.COMPLETED, BoxMigrationState.PENDING_EXPORT],
    [JobType.ROLLBACK_EXPORT_BOX, JobStatus.COMPLETED, BoxMigrationState.PENDING_ROLLBACK],
    [JobType.ROLLBACK_IMPORT_BOX, JobStatus.COMPLETED, BoxMigrationState.PENDING_ROLLBACK],
    [JobType.DISCARD_EXPORTED_BOX, JobStatus.COMPLETED, BoxMigrationState.PENDING_DISCARD_EXPORTED],
    [JobType.EXPORT_BOX, JobStatus.FAILED, BoxMigrationState.PENDING_EXPORT],
  ] as const)(
    'rolls back a canceled %s %s result and accepts its retry',
    async (type, status, state) => {
      const job = await pendingJob(type, state)
      const before = await snapshot(job)
      const { service, completions, locks, cache } = services()
      const blocker = observer.createQueryRunner()
      await blocker.connect()
      await blocker.startTransaction()
      let reported: Promise<{ outcome: string }> | undefined
      try {
        const [{ pid: blockerPid }] = await blocker.query('SELECT pg_backend_pid() AS pid')
        await blocker.query(`SELECT "boxId" FROM "${schema}".box_migration WHERE "boxId" = $1 FOR UPDATE`, [
          job.resourceId,
        ])
        reported = service.updateJobStatus(job.id, status).then(
          () => ({ outcome: 'fulfilled' }),
          () => ({ outcome: 'rejected' }),
        )

        const backendPid = await blockedBackend(blockerPid)
        const [{ canceled }] = await observer.query('SELECT pg_cancel_backend($1) AS canceled', [backendPid])
        expect(canceled).toBe(true)
        expect(completions).toHaveLength(1)
        // Keep the blocker held until cancellation has ended the actual receiver.
        await bounded(Promise.allSettled(completions), 'canceled receiver')
        const result = await bounded(reported, 'completion report')
        expect(databaseErrors).toContain('57014')
        const observed = await snapshot(job)
        expect(observed).toEqual(before)
        expect(result.outcome).toBe('rejected')
        expect(locks.unlock).not.toHaveBeenCalled()
        expect(cache.invalidate).not.toHaveBeenCalled()
        await blocker.rollbackTransaction()
        await bounded(service.updateJobStatus(job.id, status), 'retry result')
        await bounded(Promise.allSettled(completions), 'retry receiver')
        const retried = await snapshot(job)
        expect(retried.jobStatus).toBe(status)
        const expected = {
          [JobType.IMPORT_BOX]: {
            boxRunnerId: targetRunner,
            migrationState: BoxMigrationState.PENDING_DISCARD_EXPORTED,
          },
          [JobType.EXPORT_BOX]: {
            migrationState: status === JobStatus.FAILED ? null : BoxMigrationState.PENDING_IMPORT,
          },
          [JobType.ROLLBACK_EXPORT_BOX]: { arcPath: '', migrationState: state },
          [JobType.ROLLBACK_IMPORT_BOX]: { migrationRunnerId: null, migrationState: state },
          [JobType.DISCARD_EXPORTED_BOX]: {
            migrationState: BoxMigrationState.COMPLETED,
            arcPath: '',
            migrationRunnerId: null,
          },
        }
        expect(retried).toMatchObject(expected[type])
        expect(locks.unlock).toHaveBeenCalledTimes(1)
      } finally {
        try {
          if (blocker.isTransactionActive) await blocker.rollbackTransaction()
          await bounded(Promise.allSettled([...(reported ? [reported] : []), ...completions]), 'cleanup')
        } finally {
          await blocker.release()
        }
      }
    },
    deadlineMs * 3,
  )

  it('preserves the accepted result when an acknowledged or lost-response completion is replayed', async () => {
    const job = await pendingJob()
    const { service, completions, locks, cache } = services()
    await service.updateJobStatus(job.id, JobStatus.COMPLETED, undefined, '{"accepted":true}')
    await Promise.allSettled(completions)
    const accepted = await snapshot(job)

    await service.updateJobStatus(job.id, JobStatus.COMPLETED, 'late error', '{"accepted":false}')
    await Promise.allSettled(completions)
    await expect(service.updateJobStatus(job.id, JobStatus.FAILED, 'late failure')).rejects.toBeInstanceOf(
      ConflictException,
    )

    expect(await snapshot(job)).toEqual(accepted)
    expect(locks.unlock).toHaveBeenCalledTimes(1)
    expect(cache.invalidate).toHaveBeenCalledTimes(1)
  })

  it('applies concurrent copies of the same completion once', async () => {
    const job = await pendingJob()
    const { service, completions, locks, cache } = services()
    const results = await bounded(
      Promise.all([
        service.updateJobStatus(job.id, JobStatus.COMPLETED),
        service.updateJobStatus(job.id, JobStatus.COMPLETED),
      ]),
      'concurrent results',
    )
    await Promise.allSettled(completions)

    expect(results[0].version).toBe(results[1].version)
    expect(await snapshot(job)).toMatchObject({
      jobStatus: JobStatus.COMPLETED,
      boxRunnerId: targetRunner,
      migrationState: BoxMigrationState.PENDING_DISCARD_EXPORTED,
    })
    expect(locks.unlock).toHaveBeenCalledTimes(1)
    expect(cache.invalidate).toHaveBeenCalledTimes(1)
  })
})
