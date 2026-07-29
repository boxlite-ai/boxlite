/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RedisModule, getRedisConnectionToken } from '@nestjs-modules/ioredis'
import { EventEmitterModule } from '@nestjs/event-emitter'
import { Test, TestingModule } from '@nestjs/testing'
import { TypeOrmModule } from '@nestjs/typeorm'
import type { Redis } from 'ioredis'
import { setTimeout as sleep } from 'timers/promises'
import { DataSource, IsNull, Repository } from 'typeorm'
import { RedisLockProvider } from '../box/common/redis-lock.provider'
import { BoxLastActivity } from '../box/entities/box-last-activity.entity'
import { Box } from '../box/entities/box.entity'
import { BoxDesiredState } from '../box/enums/box-desired-state.enum'
import { BoxState } from '../box/enums/box-state.enum'
import { BoxRepository } from '../box/repositories/box.repository'
import { CustomNamingStrategy } from '../common/utils/naming-strategy.util'
import { AddBoxUsagePeriods1785250000000 } from '../migrations/pre-deploy/1785250000000-add-box-usage-periods-migration'
import { BoxUsagePeriod } from './entities/box-usage-period.entity'
import { BoxUsagePeriodArchive } from './entities/box-usage-period-archive.entity'
import { UsageService } from './services/usage.service'
import { UsageModule } from './usage.module'

// usage.lifecycle.integration.spec.ts covers the happy path: every transition
// reaches its handler and the ledger tracks the box. This spec covers what
// happens when it does not.
//
// BoxRepository commits the box row and only then calls emitUpdateEvents(),
// which is an in-process EventEmitter2 emit — not awaited, not persisted, not
// retried. Between that commit and UsageService finishing its write there is a
// window in which the box table and the ledger disagree, and anything that ends
// the process in that window (SIGKILL, a crash, a restart whose 5s grace
// expires while a handler is parked on its Redis lock) drops the pending work
// with no record that it was ever owed.
//
// The question these tests answer is not "is there a window" — that is plain in
// the code — but "what does the system do about it afterwards": which drifts the
// daily roll-over corrects, which wait for the box's next real transition, and
// which nothing corrects at all. No path is retroactive, so in every case the
// span mis-billed while the drift stood stays mis-billed.
//
// Two of the groups below — an unreachable Redis losing the write, and the
// shutdown drain returning early — were found by the process-killing harness in
// apps/scripts/usage-period-chaos (its S5 and S7) and are pinned here so they
// are covered by an ordinary test run. That harness still owns anything that
// needs a real process to die; see apps/infra-local/scripts/README.md for which
// tool covers what.
//
// Runs only when a Postgres and a Redis are reachable; skipped otherwise.
// DB_DATABASE is named too: it is only the database this spec connects to in
// order to create its own, but unset it would silently build
// `undefined_...` rather than skipping.
const describeIfDatabase =
  process.env.DB_HOST && process.env.REDIS_HOST && process.env.DB_DATABASE ? describe : describe.skip

// Its own database and Redis db index, for the same reason the lifecycle spec
// has its own: Jest runs spec files concurrently and these all drop the same
// ledger tables and take the same global cron locks.
const SCENARIO_DATABASE = `${process.env.DB_DATABASE}_box_usage_crash`
const SCENARIO_REDIS_DB = 14

const DAY_MS = 24 * 60 * 60 * 1000
const ALL_TABLES = ['box_usage_periods', 'box_usage_periods_archive', 'box_last_activity', 'box']
  .map((table) => `"${table}"`)
  .join(', ')

const BOX_RESOURCES = { cpu: 2, gpu: 1, mem: 4, disk: 10 }
const compute = (overrides = {}) => expect.objectContaining({ ...BOX_RESOURCES, ...overrides })
const diskOnly = expect.objectContaining({ cpu: 0, gpu: 0, mem: 0, disk: BOX_RESOURCES.disk })

const ORGANIZATION_ID = '3f2b1c94-0000-4000-8000-000000000002'
const REGION = 'us'

describeIfDatabase('box usage periods when a handler is lost (integration, live stack)', () => {
  let moduleRef: TestingModule
  let dataSource: DataSource
  let boxRepository: BoxRepository
  let usageService: UsageService
  let redisLock: RedisLockProvider
  let periods: Repository<BoxUsagePeriod>
  let archives: Repository<BoxUsagePeriodArchive>
  let ownsDatabase = false

  // ---------------------------------------------------------------- helpers

  const openPeriods = (boxId: string) => periods.find({ where: { boxId, endAt: IsNull() } })

  const ledger = async (boxId: string): Promise<Array<BoxUsagePeriod | BoxUsagePeriodArchive>> => {
    const [live, archived] = await Promise.all([
      periods.find({ where: { boxId } }),
      archives.find({ where: { boxId } }),
    ])
    return [...live, ...archived].sort((a, b) => a.startAt.getTime() - b.startAt.getTime())
  }

  const readBox = (boxId: string) => dataSource.getRepository(Box).findOneByOrFail({ id: boxId })

  const createBox = async (overrides: Partial<Box> = {}): Promise<Box> => {
    const box = new Box(REGION)
    box.organizationId = ORGANIZATION_ID
    box.osUser = 'boxlite'
    box.state = BoxState.CREATING
    box.desiredState = BoxDesiredState.STARTED
    Object.assign(box, BOX_RESOURCES)
    box.autoPause = 0
    box.autoDelete = 0
    Object.assign(box, overrides)

    await boxRepository.insert(box)
    return box
  }

  const waitUntil = async (condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs
    while (!(await condition())) {
      if (Date.now() > deadline) {
        throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
      }
      await sleep(5)
    }
  }

  // Sound only because the scenarios below drive one transition at a time; see
  // the shutdown-drain tests for why activeJobs cannot be trusted under
  // concurrency.
  const settle = () => waitUntil(() => usageService.activeJobs.size === 0, 'usage handlers to finish')

  /** A transition whose handler ran to completion — the healthy path. */
  const drive = async (box: Box, updateData: Partial<Box>): Promise<Box> => {
    const updated = await boxRepository.update(box.id, { updateData })
    await settle()
    return updated
  }

  /**
   * A transition whose handler never wrote anything.
   *
   * The raw update commits the box row and skips emitUpdateEvents entirely,
   * which leaves the database in exactly the state a process killed between the
   * commit and the handler's write leaves behind: box row moved, ledger
   * untouched, and no in-flight work anywhere to finish it. Reproducing that by
   * actually killing a process would test Node's signal handling; this tests
   * what the system does with the result.
   */
  const crashAfterCommit = async (box: Box, updateData: Partial<Box>): Promise<Box> => {
    await boxRepository.update(box.id, { updateData }, true)
    expect(usageService.activeJobs.size).toBe(0)
    return readBox(box.id)
  }

  /** Backdates the box's open period so the roll-over cron considers it stale. */
  const ageOpenPeriod = async (boxId: string, by = DAY_MS + 60_000) => {
    await periods.update({ boxId, endAt: IsNull() }, { startAt: new Date(Date.now() - by) })
  }

  /** Everything a restarted API does to the ledger on its own, without a further transition. */
  const runReconciliation = async () => {
    await usageService.closeAndReopenUsagePeriods()
    await usageService.archiveUsagePeriods()
  }

  // ------------------------------------------------------------------ setup

  const connection = {
    type: 'postgres' as const,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    namingStrategy: new CustomNamingStrategy(),
  }

  const withAdminConnection = async (run: (admin: DataSource) => Promise<void>) => {
    const admin = await new DataSource({ ...connection, database: process.env.DB_DATABASE }).initialize()
    try {
      await run(admin)
    } finally {
      await admin.destroy()
    }
  }

  /** Boots the shipped UsageModule against the scenario database — one API process. */
  const bootApi = async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        EventEmitterModule.forRoot(),
        RedisModule.forRoot({
          type: 'single',
          options: {
            host: process.env.REDIS_HOST,
            port: Number(process.env.REDIS_PORT || 6379),
            db: SCENARIO_REDIS_DB,
            maxRetriesPerRequest: 2,
          },
        }),
        TypeOrmModule.forRoot({
          ...connection,
          database: SCENARIO_DATABASE,
          entities: [Box, BoxLastActivity, BoxUsagePeriod, BoxUsagePeriodArchive],
          synchronize: false,
        }),
        UsageModule,
      ],
    }).compile()
    await moduleRef.init()

    dataSource = moduleRef.get(DataSource)
    boxRepository = moduleRef.get(BoxRepository)
    usageService = moduleRef.get(UsageService)
    redisLock = moduleRef.get(RedisLockProvider)
    periods = dataSource.getRepository(BoxUsagePeriod)
    archives = dataSource.getRepository(BoxUsagePeriodArchive)
  }

  /**
   * A full API restart: the module graph, the connection pool, the event
   * emitter and every listener registered on it are torn down and rebuilt. Any
   * event that had been emitted but not yet handled is gone — there is no
   * queue, journal or outbox behind emitUpdateEvents to replay it from.
   */
  const restartApi = async () => {
    await moduleRef.close()
    await bootApi()
  }

  beforeAll(async () => {
    await withAdminConnection(async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS "${SCENARIO_DATABASE}" WITH (FORCE)`)
      await admin.query(`CREATE DATABASE "${SCENARIO_DATABASE}"`)
    })
    ownsDatabase = true

    const schemaSource = await new DataSource({
      ...connection,
      database: SCENARIO_DATABASE,
      entities: [Box, BoxLastActivity],
      synchronize: true,
    }).initialize()
    await schemaSource.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`)
    const queryRunner = schemaSource.createQueryRunner()
    try {
      await new AddBoxUsagePeriods1785250000000().up(queryRunner)
    } finally {
      await queryRunner.release()
      await schemaSource.destroy()
    }

    await bootApi()
  }, 60_000)

  afterAll(async () => {
    await moduleRef?.close()
    if (ownsDatabase) {
      await withAdminConnection((admin) => admin.query(`DROP DATABASE IF EXISTS "${SCENARIO_DATABASE}" WITH (FORCE)`))
    }
  })

  beforeEach(async () => {
    await dataSource.query(`TRUNCATE ${ALL_TABLES}`)
  })

  // ------------------------------------------------- the window itself

  describe('the window between the committed box row and the ledger write', () => {
    it('leaves a started box unbilled for as long as its handler has not finished', async () => {
      const box = await createBox()
      // Production's own per-box lock, taken before the transition, parks the
      // handler at its first await (UsageService.waitForLock) and holds the
      // window open for as long as this test needs it. The key is UsageService's
      // private convention; parking it from outside is the only way to observe
      // the handler mid-flight.
      const lockKey = `usage-period-${box.id}`
      expect(await redisLock.lock(lockKey, 60)).toBe(true)

      await boxRepository.update(box.id, { updateData: { state: BoxState.STARTED } })

      // The row is committed and the box is billable, but nothing bills it yet.
      // A process that dies here takes the pending handler with it.
      expect((await readBox(box.id)).state).toBe(BoxState.STARTED)
      expect(await ledger(box.id)).toEqual([])
      expect(usageService.activeJobs.size).toBeGreaterThan(0)

      await redisLock.unlock(lockKey)
      await settle()

      expect(await openPeriods(box.id)).toEqual([compute({ endAt: null })])
    })
  })

  // ------------------------------------ the handler failing, not the process

  describe('when the handler fails instead of the process', () => {
    it('loses the write to a log line when Redis is unreachable, and nothing upstream notices', async () => {
      const box = await createBox()
      const redis = moduleRef.get<Redis>(getRedisConnectionToken())
      // Cuts only this client off; the Redis server and every other client stay
      // up. RedisLockProvider.lock() awaits redis.set(), which rejects on a
      // closed connection, so the handler throws at its very first statement.
      redis.disconnect()

      try {
        // @nestjs/event-emitter wraps every @OnEvent listener in a try/catch
        // whose `suppressErrors` defaults to true
        // (event-subscribers.loader.js: `options?.suppressErrors ?? true`), and
        // UsageService's decorators pass no options. So the throw never reaches
        // the emitter's caller: update() resolves, the client gets its 200, and
        // the only trace is one logger.error line.
        await expect(boxRepository.update(box.id, { updateData: { state: BoxState.STARTED } })).resolves.toBeDefined()
        expect((await readBox(box.id)).state).toBe(BoxState.STARTED)

        await waitUntil(() => usageService.activeJobs.size === 0, 'the failed handler to unwind')
        expect(await ledger(box.id)).toEqual([])
      } finally {
        await redis.connect()
      }
    })
  })

  // ------------------------------------------------- the shutdown drain

  describe('the graceful-shutdown drain', () => {
    // main.ts calls enableShutdownHooks(), so a SIGTERM reaches
    // UsageService.onApplicationShutdown, which spins until activeJobs empties.
    // These two tests are a pair: the first shows the barrier working, which is
    // what makes the second one's failure a bug rather than a missing feature.
    it('holds the process open while a single handler is still in flight', async () => {
      const box = await createBox()
      const lockKey = `usage-period-${box.id}`
      expect(await redisLock.lock(lockKey, 60)).toBe(true)
      await boxRepository.update(box.id, { updateData: { state: BoxState.STARTED } })

      let drained = false
      const shutdown = usageService.onApplicationShutdown().then(() => {
        drained = true
      })

      // The drain polls once a second, so this waits out more than one poll.
      // Asserting that something has *not* happened needs a bounded wait; there
      // is no event to await for a promise staying pending.
      await sleep(1_500)
      expect(drained).toBe(false)

      await redisLock.unlock(lockKey)
      await shutdown

      expect(await openPeriods(box.id)).toEqual([compute({ endAt: null })])
    })

    it('reports all clear with a handler still parked, because activeJobs is keyed by method name', async () => {
      const parked = await createBox()
      const unobstructed = await createBox()
      const lockKey = `usage-period-${parked.id}`
      expect(await redisLock.lock(lockKey, 60)).toBe(true)

      await boxRepository.update(parked.id, { updateData: { state: BoxState.STARTED } })
      await boxRepository.update(unobstructed.id, { updateData: { state: BoxState.STARTED } })

      // @TrackJobExecution does activeJobs.add(propertyKey) / .delete(propertyKey)
      // — one entry per *method*, not per invocation. Both handlers are the same
      // method, so the unobstructed one deletes the entry the parked one is
      // still relying on, and the set empties while a write is outstanding.
      await waitUntil(() => usageService.activeJobs.size === 0, 'the shared activeJobs entry to be deleted')
      expect(await openPeriods(parked.id)).toEqual([])

      const startedAt = Date.now()
      await usageService.onApplicationShutdown()
      // Returns on its first check rather than waiting out the parked handler:
      // a SIGTERM here exits the process with that box unbilled.
      expect(Date.now() - startedAt).toBeLessThan(1_000)
      expect(await openPeriods(parked.id)).toEqual([])

      await redisLock.unlock(lockKey)
      await settle()
    })
  })

  // --------------------------------------------- a lost START (under-billing)

  describe('a box that reached STARTED while the API was down', () => {
    it('runs with nothing billing it', async () => {
      const box = await createBox()

      const crashed = await crashAfterCommit(box, { state: BoxState.STARTED })

      expect(crashed.state).toBe(BoxState.STARTED)
      expect(await ledger(box.id)).toEqual([])
    })

    it('is still unbilled after the API restarts and runs its reconciliation', async () => {
      const box = await createBox()
      await crashAfterCommit(box, { state: BoxState.STARTED })

      await restartApi()
      await runReconciliation()

      expect(await ledger(box.id)).toEqual([])
    })

    it('is still unbilled a week later, because the roll-over only visits periods that already exist', async () => {
      const box = await createBox()
      await crashAfterCommit(box, { state: BoxState.STARTED })

      // The roll-over selects FROM box_usage_periods; a box with no row is
      // invisible to it no matter how long it runs. Nothing else writes the
      // ledger, so there is no other repair path to wait for.
      for (let day = 0; day < 7; day += 1) {
        await usageService.closeAndReopenUsagePeriods()
      }

      expect(await ledger(box.id)).toEqual([])
    })

    it('starts billing again only at its next transition, and the compute it ran is gone for good', async () => {
      const box = await createBox()
      await crashAfterCommit(box, { state: BoxState.STARTED })

      await drive(box, { desiredState: BoxDesiredState.STOPPED, state: BoxState.STOPPING })

      // One disk-only period, opened by the stop. The entire started span before
      // it was never billed and there is nothing left to reconstruct it from.
      expect(await ledger(box.id)).toEqual([diskOnly])
    })

    it('cannot be repaired by starting it again, because the row already says started', async () => {
      const box = await createBox()
      await crashAfterCommit(box, { state: BoxState.STARTED })

      await drive(box, { desiredState: BoxDesiredState.STARTED, state: BoxState.STARTED })

      // emitUpdateEvents only fires on a *change*, so re-asserting the state the
      // row already holds emits nothing. This closes the last door: sync-states
      // skips the box for the same reason (it selects desiredState <> state), so
      // no operator action short of a real stop/start reaches the ledger.
      expect(await ledger(box.id)).toEqual([])
    })
  })

  // ------------------------------------------- a lost STOP (over-billing)

  describe('a box that reached STOPPED while the API was down', () => {
    it('keeps billing full compute while it sits stopped', async () => {
      const box = await createBox()
      await drive(box, { state: BoxState.STARTED })

      const crashed = await crashAfterCommit(box, { desiredState: BoxDesiredState.STOPPED, state: BoxState.STOPPED })

      expect(crashed.state).toBe(BoxState.STOPPED)
      expect(await openPeriods(box.id)).toEqual([compute({ endAt: null })])
    })

    it('keeps billing compute across an API restart and its reconciliation', async () => {
      const box = await createBox()
      await drive(box, { state: BoxState.STARTED })
      await crashAfterCommit(box, { desiredState: BoxDesiredState.STOPPED, state: BoxState.STOPPED })

      await restartApi()
      await runReconciliation()

      expect(await openPeriods(box.id)).toEqual([compute({ endAt: null })])
    })

    it('is corrected by the roll-over, but only once the period is a day old', async () => {
      const box = await createBox()
      await drive(box, { state: BoxState.STARTED })
      await crashAfterCommit(box, { desiredState: BoxDesiredState.STOPPED, state: BoxState.STOPPED })
      await ageOpenPeriod(box.id)

      await usageService.closeAndReopenUsagePeriods()

      // The correction is not retroactive: the day it spent stopped was billed
      // at full compute and stays billed that way.
      const billed = await ledger(box.id)
      expect(billed[0]).toEqual(compute({ endAt: expect.any(Date) }))
      expect(await openPeriods(box.id)).toEqual([diskOnly])
    })

    it('is corrected immediately if the box is started and stopped again', async () => {
      const box = await createBox()
      await drive(box, { state: BoxState.STARTED })
      await crashAfterCommit(box, { desiredState: BoxDesiredState.STOPPED, state: BoxState.STOPPED })

      await drive(box, { desiredState: BoxDesiredState.STARTED, state: BoxState.STARTED })

      expect(await openPeriods(box.id)).toEqual([compute({ endAt: null })])
    })
  })

  // --------------------------------------- a lost DESTROY (over-billing)

  describe('a box that was deleted while the API was down', () => {
    it('keeps billing a box that no longer exists to the customer', async () => {
      const box = await createBox()
      await drive(box, { state: BoxState.STARTED })

      await crashAfterCommit(box, { desiredState: BoxDesiredState.DESTROYED, state: BoxState.DESTROYED })

      expect(await openPeriods(box.id)).toEqual([compute({ endAt: null })])
    })

    it('stops billing a day later, when the roll-over sees the box is destroyed', async () => {
      const box = await createBox()
      await drive(box, { state: BoxState.STARTED })
      await crashAfterCommit(box, { desiredState: BoxDesiredState.DESTROYED, state: BoxState.DESTROYED })
      await ageOpenPeriod(box.id)

      await usageService.closeAndReopenUsagePeriods()

      expect(await openPeriods(box.id)).toEqual([])
    })

    it('is still closed a day later even after cleanup has deleted the box row', async () => {
      const box = await createBox()
      await drive(box, { state: BoxState.STARTED })
      await crashAfterCommit(box, { desiredState: BoxDesiredState.DESTROYED, state: BoxState.DESTROYED })
      await ageOpenPeriod(box.id)
      // cleanup-destroyed-boxes deletes destroyed rows 24h after they settle,
      // which is the same horizon the roll-over waits for — so the box row can
      // be gone before the ledger is repaired. No foreign key ties them.
      await dataSource.getRepository(Box).delete({ id: box.id })

      await usageService.closeAndReopenUsagePeriods()

      expect(await openPeriods(box.id)).toEqual([])
    })
  })

  // ------------------------------------------------------- a lost resize

  describe('a box that was resized while the API was down', () => {
    it('keeps billing the old size until the next transition', async () => {
      const box = await createBox()
      await drive(box, { state: BoxState.STARTED })
      await drive(box, { state: BoxState.RESIZING })

      await crashAfterCommit(box, { state: BoxState.STARTED, cpu: 8, mem: 16, disk: 40 })

      expect(await openPeriods(box.id)).toEqual([compute({ endAt: null })])
    })

    it('keeps billing the old size through the roll-over, which copies the period it found', async () => {
      const box = await createBox()
      await drive(box, { state: BoxState.STARTED })
      await drive(box, { state: BoxState.RESIZING })
      await crashAfterCommit(box, { state: BoxState.STARTED, cpu: 8, mem: 16, disk: 40 })
      await ageOpenPeriod(box.id)

      await usageService.closeAndReopenUsagePeriods()

      // fromUsagePeriod carries the old resources forward; the roll-over never
      // re-reads the box's current size, so this drift outlives every tick.
      expect(await openPeriods(box.id)).toEqual([compute({ endAt: null })])
    })
  })
})
