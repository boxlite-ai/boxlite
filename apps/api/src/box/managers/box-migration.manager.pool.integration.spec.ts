/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import { DataSource, Repository } from 'typeorm'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { Box } from '../entities/box.entity'
import { BoxLastActivity } from '../entities/box-last-activity.entity'
import { BoxMigration } from '../entities/box-migration.entity'
import { Job } from '../entities/job.entity'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxMigrationState } from '../enums/box-migration-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { JobType } from '../enums/job-type.enum'
import { BoxMigrationManager } from './box-migration.manager'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `box_migrate_pool_${process.pid}_${randomUUID().replaceAll('-', '')}`
const drainingRunnerId = '00000000-0000-4000-8000-00000000000a'
const targetRunnerId = '00000000-0000-4000-8000-00000000000b'
const organizationId = '00000000-0000-4000-8000-0000000000ff'
const SUBMIT_BUDGET_MS = 10_000

/**
 * The import leg of a migration used to resolve its target runner *inside* the
 * transaction that already holds a pool connection, so submitting needed two
 * connections at once. With one connection in the pool that is unsatisfiable by
 * construction — the same shape that deadlocked the production pool once ten
 * imports were pending at the same time (pool max defaults to 10).
 *
 * A single connection is the whole point of this suite: it turns "needs a second
 * connection" from a load-dependent race into a deterministic hang.
 */
describeIfDatabase('BoxMigrationManager import submission (integration, single-connection pool)', () => {
  let dataSource: DataSource
  let boxes: Repository<Box>
  let migrations: Repository<BoxMigration>
  let jobs: Repository<Job>
  let ownsSchema = false

  beforeAll(async () => {
    dataSource = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema: schemaName,
      entities: [Box, BoxLastActivity, BoxMigration, Job],
      namingStrategy: new CustomNamingStrategy(),
      entitySkipConstructor: true,
      synchronize: false,
      // max: 1 is the reproducer. connectionTimeoutMillis mirrors production's
      // default (0 = wait forever) so the failure is the real one — a hang —
      // rather than an acquire error this test invented.
      extra: {
        max: 1,
        connectionTimeoutMillis: 0,
        options: `-c search_path=${schemaName},public`,
      },
    }).initialize()

    await dataSource.query(`CREATE SCHEMA "${schemaName}"`)
    ownsSchema = true
    await dataSource.synchronize()
    boxes = dataSource.getRepository(Box)
    migrations = dataSource.getRepository(BoxMigration)
    jobs = dataSource.getRepository(Job)
  })

  afterAll(async () => {
    if (!dataSource?.isInitialized) {
      return
    }
    try {
      if (ownsSchema) {
        await dataSource.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
      }
    } finally {
      await dataSource.destroy()
    }
  })

  beforeEach(async () => {
    await dataSource.query(`DELETE FROM "${schemaName}"."job"`)
    await dataSource.query(`DELETE FROM "${schemaName}"."box_migration"`)
    await dataSource.query(`DELETE FROM "${schemaName}"."box_last_activity"`)
    await dataSource.query(`DELETE FROM "${schemaName}"."box"`)
  })

  /** A parked box with a migration already waiting to be imported. */
  async function pendingImport(): Promise<Box> {
    const box = new Box('us', 'pool-import')
    box.organizationId = organizationId
    box.osUser = 'boxlite'
    box.runnerId = drainingRunnerId
    box.state = BoxState.STOPPED
    box.desiredState = BoxDesiredState.STOPPED
    box.pending = false
    await boxes.insert(box)

    const stored = await boxes.findOneByOrFail({ id: box.id })
    const migration = new BoxMigration()
    migration.boxId = stored.id
    migration.state = BoxMigrationState.PENDING_IMPORT
    migration.arcPath = `box-migrations/${stored.id}.boxlite`
    // The marker's invariant: the migration carries a copy of the box's stamp,
    // which is what ValidCheck compares against.
    migration.updatedAt = stored.updatedAt
    await migrations.insert(migration)
    return stored
  }

  /**
   * The manager with real Postgres and stubs that keep the connection behaviour
   * honest: the scheduler stub queries through the same DataSource (as
   * `RunnerService.getRandomAvailableRunner` does), and the job stub writes
   * through the entity manager it is handed (as `JobService.createJob` does).
   */
  function makeManager(): BoxMigrationManager {
    const runnerService = {
      getRandomAvailableRunner: async () => {
        await dataSource.getRepository(Box).count()
        return { id: targetRunnerId }
      },
    } as any
    const jobService = {
      createJob: async (manager: any, type: JobType, runnerId: string, resourceType: any, resourceId: string) => {
        const job = new Job({ type, runnerId, resourceType, resourceId })
        await manager.getRepository(Job).insert(job)
        return job
      },
    } as any
    const redisLockProvider = {
      lock: async () => true,
      unlock: async () => undefined,
    } as any
    const configService = { getOrThrow: () => 'box-migrations/' } as any

    return new BoxMigrationManager(dataSource, runnerService, jobService, redisLockProvider, configService)
  }

  it(
    'submits IMPORT_BOX with only one pool connection available',
    async () => {
      const box = await pendingImport()
      const manager = makeManager()

      let stallTimer: NodeJS.Timeout | undefined
      const outcome = await Promise.race([
        manager.submitMigrationJobs().then(() => 'completed' as const),
        new Promise<'stalled'>((resolve) => {
          stallTimer = setTimeout(() => resolve('stalled'), SUBMIT_BUDGET_MS)
        }),
      ]).finally(() => clearTimeout(stallTimer))

      expect(outcome).toBe('completed')
      const job = await jobs.findOneByOrFail({ resourceId: box.id })
      expect(job.type).toBe(JobType.IMPORT_BOX)
      expect(job.runnerId).toBe(targetRunnerId)
    },
    SUBMIT_BUDGET_MS + 10_000,
  )
})
