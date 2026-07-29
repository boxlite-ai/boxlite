/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RedisModule } from '@nestjs-modules/ioredis'
import { EventEmitterModule } from '@nestjs/event-emitter'
import { Test, TestingModule } from '@nestjs/testing'
import { TypeOrmModule } from '@nestjs/typeorm'
import { setTimeout as sleep } from 'timers/promises'
import { DataSource, IsNull, Repository } from 'typeorm'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../box/constants/box.constants'
import { BoxLastActivity } from '../box/entities/box-last-activity.entity'
import { Box } from '../box/entities/box.entity'
import { BoxDesiredState } from '../box/enums/box-desired-state.enum'
import { BoxState } from '../box/enums/box-state.enum'
import { BoxRepository } from '../box/repositories/box.repository'
import { generateBoxId } from '../box/utils/box-id.util'
import { CustomNamingStrategy } from '../common/utils/naming-strategy.util'
import { AddBoxUsagePeriods1785250000000 } from '../migrations/pre-deploy/1785250000000-add-box-usage-periods-migration'
import { BoxUsagePeriod } from './entities/box-usage-period.entity'
import { BoxUsagePeriodArchive } from './entities/box-usage-period-archive.entity'
import { UsageService } from './services/usage.service'
import { UsageModule } from './usage.module'

// The service specs drive UsageService directly: they hand it events they built
// themselves and a stubbed box repository. That proves the handler bodies, not
// that a box moving through its states ever produces those events, nor that the
// real UsageModule can be wired against a real database. This spec closes that
// gap — every transition below goes through the production BoxRepository, whose
// own emit is the only thing that reaches the handlers, and the module graph is
// the shipped UsageModule on a real Postgres and Redis.
//
// Runs only when a Postgres and a Redis are reachable; skipped otherwise.
// DB_DATABASE is named too: it is only the database this spec connects to in
// order to create its own, but unset it would silently build
// `undefined_...` rather than skipping.
const describeIfDatabase =
  process.env.DB_HOST && process.env.REDIS_HOST && process.env.DB_DATABASE ? describe : describe.skip

// Jest runs spec files concurrently, and usage.service.integration.spec.ts drops
// the same ledger tables and takes the same global cron locks — sharing either
// would make whichever file lost the race silently assert against the other's
// state. So this spec owns a database it creates and drops itself, and a Redis
// db index of its own.
const SCENARIO_DATABASE = `${process.env.DB_DATABASE}_box_usage_scenarios`
const SCENARIO_REDIS_DB = 15

const DAY_MS = 24 * 60 * 60 * 1000
const LEDGER_TABLES = ['box_usage_periods', 'box_usage_periods_archive']
const BOX_TABLES = ['box_last_activity', 'box']
const ALL_TABLES = [...LEDGER_TABLES, ...BOX_TABLES].map((table) => `"${table}"`).join(', ')

// A box only bills for what it consumes, so every assertion below is about one
// of two shapes: a compute period (the box's real cpu/gpu/mem) or a disk-only
// period (a stopped box still occupies its disk).
const BOX_RESOURCES = { cpu: 2, gpu: 1, mem: 4, disk: 10 }
const compute = (overrides = {}) => expect.objectContaining({ ...BOX_RESOURCES, ...overrides })
const diskOnly = expect.objectContaining({ cpu: 0, gpu: 0, mem: 0, disk: BOX_RESOURCES.disk })

const ORGANIZATION_ID = '3f2b1c94-0000-4000-8000-000000000001'
const REGION = 'us'

describeIfDatabase('box usage periods (integration, live stack)', () => {
  let moduleRef: TestingModule
  let dataSource: DataSource
  let boxRepository: BoxRepository
  let usageService: UsageService
  let periods: Repository<BoxUsagePeriod>
  let archives: Repository<BoxUsagePeriodArchive>
  // Set once this spec has created its database; until then there is nothing of
  // its own to drop, and it must not drop anybody else's.
  let ownsDatabase = false

  // ---------------------------------------------------------------- helpers

  const openPeriods = (boxId: string) => periods.find({ where: { boxId, endAt: IsNull() } })

  // The archive cron moves closed periods out of box_usage_periods, so the
  // billed history of a box is the union of both tables — reading either alone
  // would make an assertion depend on whether the cron happened to have run.
  const ledger = async (boxId: string): Promise<Array<BoxUsagePeriod | BoxUsagePeriodArchive>> => {
    const [live, archived] = await Promise.all([
      periods.find({ where: { boxId } }),
      archives.find({ where: { boxId } }),
    ])
    return [...live, ...archived].sort((a, b) => a.startAt.getTime() - b.startAt.getTime())
  }

  const createBox = async (overrides: Partial<Box> = {}): Promise<Box> => {
    const box = new Box(REGION)
    box.organizationId = ORGANIZATION_ID
    box.osUser = 'boxlite'
    box.state = BoxState.CREATING
    box.desiredState = BoxDesiredState.STARTED
    Object.assign(box, BOX_RESOURCES)
    // The manager's auto-stop and auto-delete sweeps key off these; a scenario
    // box must be inert to everything except the transitions it is driven through.
    box.autoPause = 0
    box.autoDelete = 0
    Object.assign(box, overrides)

    await boxRepository.insert(box)
    return box
  }

  // BoxRepository.update() emits synchronously, so by the time it resolves the
  // handler has already registered itself in activeJobs — production's own
  // shutdown barrier doubles as this spec's settle point, with no sleep-for-a-
  // guessed-duration anywhere.
  const settle = async () => {
    const deadline = Date.now() + 10_000
    while (usageService.activeJobs.size > 0) {
      if (Date.now() > deadline) {
        throw new Error(`usage handlers still running after 10s: ${[...usageService.activeJobs].join(', ')}`)
      }
      await sleep(5)
    }
  }

  const drive = async (box: Box, updateData: Partial<Box>): Promise<Box> => {
    const updated = await boxRepository.update(box.id, { updateData })
    await settle()
    return updated
  }

  /** Backdates the box's open period so the roll-over cron considers it stale. */
  const ageOpenPeriod = async (boxId: string, by = DAY_MS + 60_000) => {
    await periods.update({ boxId, endAt: IsNull() }, { startAt: new Date(Date.now() - by) })
  }

  const insertOpenPeriod = (overrides: Partial<BoxUsagePeriod> = {}) =>
    periods.save(
      periods.create({
        boxId: generateBoxId(),
        organizationId: ORGANIZATION_ID,
        region: REGION,
        ...BOX_RESOURCES,
        startAt: new Date(),
        endAt: null,
        ...overrides,
      }),
    )

  /**
   * A box's periods must tile its lifetime: each one ends before the next
   * starts (an overlap is billed twice) and leaves no hole behind it (a gap is
   * billed to nobody). Closing and reopening take two `new Date()` calls, so
   * the seam is a few milliseconds wide rather than exact.
   */
  const assertContiguous = (chain: Array<{ startAt: Date; endAt: Date | null }>, maxGapMs = 1_000) => {
    for (let i = 1; i < chain.length; i += 1) {
      const previousEnd = chain[i - 1].endAt
      if (previousEnd === null) {
        throw new Error(`period ${i - 1} of ${chain.length} is still open, so period ${i} overlaps it`)
      }
      const gapMs = chain[i].startAt.getTime() - previousEnd.getTime()
      expect(gapMs).toBeGreaterThanOrEqual(0)
      expect(gapMs).toBeLessThan(maxGapMs)
    }
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

  /** Connects to the database the environment points at, only to create or drop this spec's own. */
  const withAdminConnection = async (run: (admin: DataSource) => Promise<void>) => {
    const admin = await new DataSource({ ...connection, database: process.env.DB_DATABASE }).initialize()
    try {
      await run(admin)
    } finally {
      await admin.destroy()
    }
  }

  beforeAll(async () => {
    await withAdminConnection(async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS "${SCENARIO_DATABASE}" WITH (FORCE)`)
      await admin.query(`CREATE DATABASE "${SCENARIO_DATABASE}"`)
    })
    ownsDatabase = true

    // `box` comes from its entity — its schema is not this module's contract —
    // while the ledger tables are built by running the migration that ships, so
    // the partial unique index under test is the one production will have.
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

    // ScheduleModule is deliberately absent: the crons are invoked explicitly so
    // a scenario never races a background tick.
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
    periods = dataSource.getRepository(BoxUsagePeriod)
    archives = dataSource.getRepository(BoxUsagePeriodArchive)
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

  // ------------------------------------------- a box moving through its states

  describe('a box moving through its states', () => {
    it('opens one compute period when the box reaches STARTED', async () => {
      const box = await createBox()

      await drive(box, { state: BoxState.STARTED })

      const billed = await ledger(box.id)
      expect(billed).toEqual([compute({ endAt: null, organizationId: ORGANIZATION_ID, region: REGION })])
      expect(Date.now() - billed[0].startAt.getTime()).toBeLessThan(10_000)
    })

    it('bills nothing for a box that never starts', async () => {
      const box = await createBox()

      await drive(box, { state: BoxState.ERROR })

      expect(await ledger(box.id)).toEqual([])
    })

    it('switches to disk-only billing the moment a stop is requested', async () => {
      const box = await createBox()
      await drive(box, { state: BoxState.STARTED })

      await drive(box, { desiredState: BoxDesiredState.STOPPED, state: BoxState.STOPPING })

      const [computePeriod, diskPeriod] = await ledger(box.id)
      expect(computePeriod).toEqual(compute({ endAt: expect.any(Date) }))
      expect(diskPeriod).toEqual(diskOnly)
      expect(diskPeriod.endAt).toBeNull()
    })

    it('adds no row when the box lands in STOPPED after STOPPING', async () => {
      const box = await createBox()
      await drive(box, { state: BoxState.STARTED })
      await drive(box, { desiredState: BoxDesiredState.STOPPED, state: BoxState.STOPPING })

      await drive(box, { state: BoxState.STOPPED })

      expect(await ledger(box.id)).toHaveLength(2)
      expect(await openPeriods(box.id)).toEqual([diskOnly])
    })

    it('stops charging compute when the box lands in STOPPED without passing through STOPPING', async () => {
      const box = await createBox()
      await drive(box, { state: BoxState.STARTED })

      await drive(box, { desiredState: BoxDesiredState.STOPPED, state: BoxState.STOPPED })

      const [computePeriod, diskPeriod] = await ledger(box.id)
      expect(computePeriod).toEqual(compute({ endAt: expect.any(Date) }))
      expect(diskPeriod).toEqual(diskOnly)
      expect(diskPeriod.endAt).toBeNull()
    })

    it('resumes compute billing when a stopped box starts again', async () => {
      const box = await createBox()
      await drive(box, { state: BoxState.STARTED })
      await drive(box, { desiredState: BoxDesiredState.STOPPED, state: BoxState.STOPPED })

      await drive(box, { desiredState: BoxDesiredState.STARTED, state: BoxState.STARTED })

      const billed = await ledger(box.id)
      expect(billed).toHaveLength(3)
      expect(billed[1]).toEqual(expect.objectContaining({ cpu: 0, endAt: expect.any(Date) }))
      expect(billed[2]).toEqual(compute({ endAt: null }))
    })

    it('bills the new size after a resize, not the old one', async () => {
      const box = await createBox()
      await drive(box, { state: BoxState.STARTED })

      await drive(box, { state: BoxState.RESIZING })
      await drive(box, { state: BoxState.STARTED, cpu: 8, mem: 16, disk: 40 })

      const billed = await ledger(box.id)
      expect(billed).toHaveLength(2)
      expect(billed[0]).toEqual(compute({ endAt: expect.any(Date) }))
      expect(billed[1]).toEqual(expect.objectContaining({ cpu: 8, mem: 16, disk: 40, endAt: null }))
    })

    it('stops billing when deletion is requested, not when the box is finally gone', async () => {
      const box = await createBox()
      await drive(box, { state: BoxState.STARTED })

      await drive(box, { desiredState: BoxDesiredState.DESTROYED })

      expect(await openPeriods(box.id)).toEqual([])
      expect(await ledger(box.id)).toEqual([compute({ endAt: expect.any(Date) })])
    })

    it('neither reopens nor re-closes as a deleted box walks DESTROYING to DESTROYED', async () => {
      const box = await createBox()
      await drive(box, { state: BoxState.STARTED })
      await drive(box, { desiredState: BoxDesiredState.DESTROYED })
      const [closedAtDeleteRequest] = await ledger(box.id)

      await drive(box, { state: BoxState.DESTROYING })
      await drive(box, { state: BoxState.DESTROYED })

      const billed = await ledger(box.id)
      expect(billed).toHaveLength(1)
      expect(billed[0].endAt).toEqual(closedAtDeleteRequest.endAt)
    })

    it('closes the period when a running box errors', async () => {
      const box = await createBox()
      await drive(box, { state: BoxState.STARTED })

      await drive(box, { state: BoxState.ERROR })

      expect(await openPeriods(box.id)).toEqual([])
      expect(await ledger(box.id)).toEqual([compute({ endAt: expect.any(Date) })])
    })

    it.each([
      ['STARTING', BoxState.STARTING],
      ['RESTORING', BoxState.RESTORING],
      ['RESIZING', BoxState.RESIZING],
    ])('leaves the ledger alone while the box passes through %s', async (_label, state) => {
      const box = await createBox()
      await drive(box, { state: BoxState.STARTED })
      const [opened] = await ledger(box.id)

      await drive(box, { state })

      const billed = await ledger(box.id)
      expect(billed).toHaveLength(1)
      expect(billed[0].id).toEqual(opened.id)
      expect(billed[0].endAt).toBeNull()
    })

    it('keeps two boxes independent', async () => {
      const stopped = await createBox()
      const running = await createBox()
      await drive(stopped, { state: BoxState.STARTED })
      await drive(running, { state: BoxState.STARTED })

      await drive(stopped, { desiredState: BoxDesiredState.STOPPED, state: BoxState.STOPPING })

      expect(await openPeriods(running.id)).toEqual([compute({ endAt: null })])
      expect(await openPeriods(stopped.id)).toEqual([diskOnly])
    })

    it('bills a full start/stop/start/delete lifecycle as one unbroken, non-overlapping chain', async () => {
      const box = await createBox()

      await drive(box, { state: BoxState.STARTED })
      await drive(box, { desiredState: BoxDesiredState.STOPPED, state: BoxState.STOPPING })
      await drive(box, { state: BoxState.STOPPED })
      await drive(box, { desiredState: BoxDesiredState.STARTED, state: BoxState.STARTED })
      await drive(box, { desiredState: BoxDesiredState.DESTROYED })
      await drive(box, { state: BoxState.DESTROYED })

      const billed = await ledger(box.id)
      expect(billed.map((period) => period.cpu)).toEqual([BOX_RESOURCES.cpu, 0, BOX_RESOURCES.cpu])
      expect(billed.every((period) => period.endAt !== null)).toBe(true)
      assertContiguous(billed)
    })
  })

  // ---------------------------------------------------------- roll-over cron

  describe('the daily roll-over', () => {
    it('carries a running box into a fresh period that starts exactly where the old one ended', async () => {
      const box = await createBox()
      await drive(box, { state: BoxState.STARTED })
      await ageOpenPeriod(box.id)

      await usageService.closeAndReopenUsagePeriods()

      const [closed, reopened] = await ledger(box.id)
      expect(reopened).toEqual(compute({ endAt: null, organizationId: ORGANIZATION_ID, region: REGION }))
      expect(reopened.startAt).toEqual(closed.endAt)
    })

    it('zeroes compute for a box that is already stopped', async () => {
      const box = await createBox()
      await drive(box, { state: BoxState.STARTED })
      // A raw update changes the row without emitting, which is what a crashed
      // or missed handler leaves behind: a stopped box still carrying an open
      // compute period. Without the zeroing branch the roll-over would re-bill
      // that box a full cpu every day, forever.
      await boxRepository.update(box.id, { updateData: { state: BoxState.STOPPED } }, true)
      await ageOpenPeriod(box.id)

      await usageService.closeAndReopenUsagePeriods()

      expect(await openPeriods(box.id)).toEqual([diskOnly])
    })

    it('keeps billing disk for a box still stopping', async () => {
      const box = await createBox()
      await drive(box, { state: BoxState.STARTED })
      await drive(box, { desiredState: BoxDesiredState.STOPPED, state: BoxState.STOPPING })
      await ageOpenPeriod(box.id)

      await usageService.closeAndReopenUsagePeriods()

      expect(await openPeriods(box.id)).toEqual([diskOnly])
    })

    it('closes without reopening once the box is destroyed', async () => {
      const box = await createBox()
      await drive(box, { state: BoxState.STARTED })
      // Raw, so the destroy never reaches the handlers — the roll-over is the
      // last line of defence against a period left open on a dead box.
      await boxRepository.update(
        box.id,
        { updateData: { desiredState: BoxDesiredState.DESTROYED, state: BoxState.DESTROYED } },
        true,
      )
      await ageOpenPeriod(box.id)

      await usageService.closeAndReopenUsagePeriods()

      expect(await openPeriods(box.id)).toEqual([])
      expect(await ledger(box.id)).toEqual([compute({ endAt: expect.any(Date) })])
    })

    it('closes without reopening when the box row is gone', async () => {
      const orphan = await insertOpenPeriod({ startAt: new Date(Date.now() - DAY_MS - 60_000) })

      await usageService.closeAndReopenUsagePeriods()

      expect(await openPeriods(orphan.boxId)).toEqual([])
      expect(await ledger(orphan.boxId)).toEqual([expect.objectContaining({ endAt: expect.any(Date) })])
    })

    it('leaves a period younger than a day alone', async () => {
      const box = await createBox()
      await drive(box, { state: BoxState.STARTED })
      await ageOpenPeriod(box.id, DAY_MS - 60_000)

      await usageService.closeAndReopenUsagePeriods()

      expect(await ledger(box.id)).toHaveLength(1)
      expect(await openPeriods(box.id)).toHaveLength(1)
    })

    it('leaves warm-pool periods alone, since no organization owns them yet', async () => {
      const warmPool = await insertOpenPeriod({
        organizationId: BOX_WARM_POOL_UNASSIGNED_ORGANIZATION,
        startAt: new Date(Date.now() - DAY_MS - 60_000),
      })

      await usageService.closeAndReopenUsagePeriods()

      expect(await openPeriods(warmPool.boxId)).toHaveLength(1)
    })

    it('leaves exactly one open period per box behind', async () => {
      const box = await createBox()
      await drive(box, { state: BoxState.STARTED })
      await ageOpenPeriod(box.id)

      await usageService.closeAndReopenUsagePeriods()

      expect(await openPeriods(box.id)).toHaveLength(1)
    })

    it('caps a single run at 100 periods, leaving the rest for the next tick', async () => {
      const stale = new Date(Date.now() - DAY_MS - 60_000)
      for (let i = 0; i < 101; i += 1) {
        await insertOpenPeriod({ startAt: new Date(stale.getTime() + i) })
      }

      await usageService.closeAndReopenUsagePeriods()

      expect(await periods.count({ where: { endAt: IsNull() } })).toBe(1)
    })
  })

  // ------------------------------------------------------------ archive cron

  describe('the archive sweep', () => {
    it('moves every closed period across with its billed fields intact', async () => {
      const box = await createBox()
      await drive(box, { state: BoxState.STARTED })
      await drive(box, { desiredState: BoxDesiredState.STOPPED, state: BoxState.STOPPING })
      const [closed] = await periods.find({ where: { boxId: box.id } })

      await usageService.archiveUsagePeriods()

      expect(await archives.find({ where: { boxId: box.id } })).toEqual([
        compute({
          boxId: box.id,
          organizationId: ORGANIZATION_ID,
          region: REGION,
          startAt: closed.startAt,
          endAt: closed.endAt,
        }),
      ])
    })

    it('leaves the still-accruing period where billing can find it', async () => {
      const box = await createBox()
      await drive(box, { state: BoxState.STARTED })
      await drive(box, { desiredState: BoxDesiredState.STOPPED, state: BoxState.STOPPING })

      await usageService.archiveUsagePeriods()

      expect(await periods.find({ where: { boxId: box.id } })).toEqual([diskOnly])
      expect(await ledger(box.id)).toHaveLength(2)
    })

    it('is a no-op once there is nothing closed left to move', async () => {
      const box = await createBox()
      await drive(box, { state: BoxState.STARTED })
      await drive(box, { desiredState: BoxDesiredState.STOPPED, state: BoxState.STOPPING })
      await usageService.archiveUsagePeriods()
      const afterFirstSweep = await ledger(box.id)

      await usageService.archiveUsagePeriods()

      expect(await ledger(box.id)).toEqual(afterFirstSweep)
    })
  })

  // ------------------------------------------------------------- concurrency

  describe('under concurrency', () => {
    it('still leaves one open period when a stop races the roll-over', async () => {
      const box = await createBox()
      await drive(box, { state: BoxState.STARTED })
      await ageOpenPeriod(box.id)

      await Promise.all([
        usageService.closeAndReopenUsagePeriods(),
        boxRepository.update(box.id, {
          updateData: { desiredState: BoxDesiredState.STOPPED, state: BoxState.STOPPING },
        }),
      ])
      await settle()

      expect(await openPeriods(box.id)).toHaveLength(1)
      assertContiguous(await ledger(box.id))
    })

    it('refuses a second open period for the same box', async () => {
      const box = await createBox()
      await drive(box, { state: BoxState.STARTED })

      await expect(insertOpenPeriod({ boxId: box.id })).rejects.toThrow(/box_usage_periods_one_open_period_per_box_idx/)
    })
  })
})
