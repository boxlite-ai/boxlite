/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import { DataSource, Repository } from 'typeorm'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { RedisLockProvider } from '../common/redis-lock.provider'
import { Box } from '../entities/box.entity'
import { BoxLastActivity } from '../entities/box-last-activity.entity'
import { BoxMigration } from '../entities/box-migration.entity'
import { Runner } from '../entities/runner.entity'
import { BoxClass } from '../enums/box-class.enum'
import { RunnerState } from '../enums/runner-state.enum'
import { BoxRepository } from '../repositories/box.repository'
import { BoxService } from './box.service'
import { RunnerService } from './runner.service'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip

// Its own database, not a schema in the shared one. The Runner entity's
// `@PrimaryGeneratedColumn('uuid')` makes TypeORM issue
// `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"` on connect, and that statement is
// not atomic — a sibling suite doing the same concurrently collides on
// pg_extension_name_index. usage.service.integration.spec.ts also drops and
// recreates schema public wholesale, which would take the extension with it. A
// private database removes both couplings.
const databaseName = `runner_assignment_${process.pid}_${randomUUID().replaceAll('-', '')}`
const schemaName = 'public'
const organizationId = '00000000-0000-4000-8000-0000000000ff'
const region = 'us'

// Enough concurrent creates to make the collision structural rather than a
// timing coincidence: every caller resolves its candidate query before any of
// them reaches the assignment step, so all of them target the single runner.
const BURST = 8

describeIfDatabase('BoxService runner assignment under concurrency (integration, real Postgres)', () => {
  let dataSource: DataSource
  let boxes: Repository<Box>
  let runners: Repository<Runner>
  let boxRepository: BoxRepository
  let redis: Redis
  let service: BoxService
  let ownsDatabase = false

  function readyRunner(): Runner {
    const runner = new Runner({
      region,
      name: `runner-${randomUUID().slice(0, 8)}`,
      apiKey: 'test-key',
      apiVersion: '2',
      cpu: 64,
      memoryGiB: 256,
      diskGiB: 2048,
    })
    runner.class = BoxClass.SMALL
    runner.state = RunnerState.READY
    runner.availabilityScore = 100
    runner.lastChecked = new Date()
    return runner
  }

  function pendingBox(name: string): Box {
    const box = new Box(region, name)
    box.organizationId = organizationId
    box.osUser = 'boxlite'
    box.class = BoxClass.SMALL
    box.pending = true
    return box
  }

  // Drives the same private assignment the create path uses, so the assertions
  // cover production runner selection + assignment rather than a
  // re-implementation.
  function assignBox(name: string): Promise<Box> {
    const box = pendingBox(name)
    return (service as any).persistOnAvailableRunner(box, { regions: [region], boxClass: BoxClass.SMALL }, () =>
      boxRepository.insert(box),
    )
  }

  beforeAll(async () => {
    const connection = {
      type: 'postgres' as const,
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
    }

    // Entity-free so no uuid column exists to trigger the extension on this
    // connection; CREATE DATABASE cannot run inside a transaction, and
    // dataSource.query is autocommit.
    const admin = await new DataSource({ ...connection, database: process.env.DB_DATABASE }).initialize()
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      ownsDatabase = true
    } finally {
      await admin.destroy()
    }

    dataSource = await new DataSource({
      ...connection,
      database: databaseName,
      entities: [Box, BoxLastActivity, BoxMigration, Runner],
      namingStrategy: new CustomNamingStrategy(),
      entitySkipConstructor: true,
      synchronize: false,
    }).initialize()

    await dataSource.synchronize()

    boxes = dataSource.getRepository(Box)
    runners = dataSource.getRepository(Runner)
    redis = new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: Number(process.env.REDIS_PORT || 6379),
    })

    boxRepository = new BoxRepository(
      dataSource,
      { emit: jest.fn() } as any,
      { invalidate: jest.fn(), invalidateOrgId: jest.fn() } as any,
    )

    // Real candidate selection: findAvailableRunners / getRandomAvailableRunner /
    // findOneUncachedOrFail all read through this repository, so the score gate
    // and the `excludedRunnerIds` filter are the production ones.
    const runnerService = Object.create(RunnerService.prototype) as RunnerService
    Object.assign(runnerService as any, {
      runnerRepository: runners,
      configService: { getOrThrow: jest.fn().mockReturnValue(10) },
      dataSource,
    })

    service = Object.create(BoxService.prototype) as BoxService
    Object.assign(service as any, {
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      boxRepository,
      runnerService,
      dataSource,
      // Wired even though assignment reaches for neither: a fixture that omits
      // a collaborator the code under test could use cannot tell an unlocked
      // assignment from a mis-assembled one — if production started opening a
      // transaction or taking a lease again, these are what it would find.
      redisLockProvider: new RedisLockProvider(redis),
      redis,
    })
  })

  afterAll(async () => {
    redis?.disconnect()
    if (!dataSource?.isInitialized) {
      return
    }

    await dataSource.destroy()

    if (!ownsDatabase) {
      return
    }

    const admin = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
    }).initialize()
    try {
      // A failed test can leave a row-lock waiter holding a connection open, and
      // DROP DATABASE refuses while any session is attached — it would report
      // that instead of the assertion that actually failed.
      await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
    } finally {
      await admin.destroy()
    }
  })

  beforeEach(async () => {
    await dataSource.query(`DELETE FROM "${schemaName}"."box_last_activity"`)
    await dataSource.query(`DELETE FROM "${schemaName}"."box"`)
    await dataSource.query(`DELETE FROM "${schemaName}"."runner"`)
    await redis.flushdb()
  })

  it('assigns every box in a concurrent burst to the only schedulable runner', async () => {
    const runner = readyRunner()
    await runners.insert(runner)

    const settled = await Promise.allSettled(Array.from({ length: BURST }, (_, i) => assignBox(`burst-${i}`)))

    // Surfacing the messages rather than a bare count: `No available runners`
    // is the spurious capacity error this guards against, and it must not
    // appear when the fleet was never out of capacity.
    expect(
      settled.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason?.message),
    ).toEqual([])
    expect(await boxes.countBy({ runnerId: runner.id })).toBe(BURST)
  })

  it('assigns onto a runner a drain is mid-commit instead of waiting for it', async () => {
    const runner = readyRunner()
    await runners.insert(runner)

    // The exact lock strength updateDrainingStatus and the decommission
    // verification take, held from an independent connection with the flag
    // already written but not yet committed.
    const drain = dataSource.createQueryRunner()
    await drain.connect()
    await drain.startTransaction()
    await drain.query(`SELECT "id" FROM "${schemaName}"."runner" WHERE "id" = $1 FOR UPDATE`, [runner.id])
    await drain.query(`UPDATE "${schemaName}"."runner" SET "draining" = true WHERE "id" = $1`, [runner.id])

    try {
      const box = await assignBox('drained-under-us')

      // Resolved while the drain still owns the row: assignment takes no lock
      // on it, so it never queues behind a lifecycle writer.
      expect(drain.isTransactionActive).toBe(true)
      expect(box.runnerId).toBe(runner.id)

      await drain.commitTransaction()
    } finally {
      if (drain.isTransactionActive) {
        await drain.rollbackTransaction()
      }
      await drain.release()
    }

    // The accepted outcome: a box sitting on a runner that is now draining.
    // Nothing is lost — the drain waits this box out instead of decommissioning
    // past it.
    expect(await runners.findOneByOrFail({ id: runner.id })).toMatchObject({ draining: true })
    expect(await boxes.countBy({ runnerId: runner.id })).toBe(1)
  }, 20_000)

  it('excludes a runner that is genuinely draining and reports no candidate remains', async () => {
    const runner = readyRunner()
    runner.draining = true
    await runners.insert(runner)

    // No contention here — the runner is simply unschedulable, so the 400 that
    // says "nowhere to put this" is the honest answer.
    await expect(assignBox('draining-target')).rejects.toMatchObject({ status: 400 })
    expect(await boxes.countBy({ runnerId: runner.id })).toBe(0)
  })
})
