/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Redis } from 'ioredis'
import { DataSource, Repository } from 'typeorm'
import { BoxState } from '../../box/enums/box-state.enum'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../../box/constants/box.constants'
import { RedisLockProvider } from '../../box/common/redis-lock.provider'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { AddBoxUsagePeriods1785250000000 } from '../../migrations/pre-deploy/1785250000000-add-box-usage-periods-migration'
import { BoxUsagePeriod } from '../entities/box-usage-period.entity'
import { BoxUsagePeriodArchive } from '../entities/box-usage-period-archive.entity'
import { UsageService } from './usage.service'

// The two cron jobs are a destructive archive transaction and a roll-over that
// rewrites resources — neither is observable without a real database, and the
// at-most-one-open-period invariant lives in a Postgres partial index whose
// WHERE clause no schema differ compares. The schema here is built by running
// the migration, so these tests exercise the DDL that actually ships. Runs only
// when a Postgres and a Redis are reachable; skipped otherwise.
const describeIfDatabase = process.env.DB_HOST && process.env.REDIS_HOST ? describe : describe.skip

const DAY_MS = 24 * 60 * 60 * 1000
const TABLES = ['box_usage_periods', 'box_usage_periods_archive']

describeIfDatabase('UsageService (integration, real Postgres + Redis)', () => {
  let dataSource: DataSource
  let redis: Redis
  let periods: Repository<BoxUsagePeriod>
  let archives: Repository<BoxUsagePeriodArchive>
  // Set only once this spec has built the tables itself. Until then the rows in
  // them belong to somebody else and nothing here may write or clear them.
  let ownsTables = false

  const box = { id: 'box-int-1', organizationId: 'org-int-1', region: 'us', cpu: 2, gpu: 1, mem: 4, disk: 10 }

  // The service's own lock keys — cleared individually so a parallel spec
  // sharing this Redis keeps its state.
  const lockKeys = [`usage-period-${box.id}`, 'close-and-reopen-usage-periods', 'archive-usage-periods']

  const openPeriod = (overrides: Partial<BoxUsagePeriod> = {}) =>
    periods.save(
      periods.create({
        boxId: box.id,
        organizationId: box.organizationId,
        region: box.region,
        cpu: box.cpu,
        gpu: box.gpu,
        mem: box.mem,
        disk: box.disk,
        startAt: new Date(),
        endAt: null,
        ...overrides,
      }),
    )

  const serviceForBoxState = (state: BoxState) =>
    new UsageService(periods, new RedisLockProvider(redis), {
      findOne: async () => ({ id: box.id, state }),
    } as any)

  const quoted = TABLES.map((table) => `"${table}"`).join(', ')
  const dropTables = () => dataSource.query(`DROP TABLE IF EXISTS ${quoted}`)
  const truncateTables = () => dataSource.query(`TRUNCATE ${quoted}`)

  // This spec owns the ledger tables outright — it drops and rebuilds them from
  // the migration — so it must never be pointed at a database holding real
  // usage. Each table is checked on its own: one populated table is enough to
  // refuse, even if the other is missing.
  const assertDisposableDatabase = async () => {
    const existing: string[] = (
      await dataSource.query(`SELECT table_name FROM information_schema.tables WHERE table_name = ANY($1)`, [TABLES])
    ).map((row: { table_name: string }) => row.table_name)

    for (const table of existing) {
      const [{ rows }] = await dataSource.query(`SELECT count(*)::int AS rows FROM "${table}"`)
      if (rows > 0) {
        throw new Error(
          `refusing to run: "${table}" in database "${process.env.DB_DATABASE}" already holds rows — point DB_* at a disposable database`,
        )
      }
    }
  }

  beforeAll(async () => {
    dataSource = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      entities: [BoxUsagePeriod, BoxUsagePeriodArchive],
      namingStrategy: new CustomNamingStrategy(),
      synchronize: false,
    }).initialize()

    // Rebuild the schema from the migration every run, so these tests exercise
    // the DDL that ships rather than whatever an earlier run happened to leave.
    await assertDisposableDatabase()
    await dropTables()
    await dataSource.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`)
    const queryRunner = dataSource.createQueryRunner()
    try {
      await new AddBoxUsagePeriods1785250000000().up(queryRunner)
      ownsTables = true
    } finally {
      await queryRunner.release()
    }

    redis = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT || 6379),
      maxRetriesPerRequest: 2,
    })
    periods = dataSource.getRepository(BoxUsagePeriod)
    archives = dataSource.getRepository(BoxUsagePeriodArchive)
  })

  // Setup can throw (the disposable-database guard), so nothing here may assume
  // it ran to completion.
  afterAll(async () => {
    if (redis) {
      await redis.del(...lockKeys)
      await redis.quit()
    }
    if (dataSource?.isInitialized) {
      if (ownsTables) {
        // leave the schema in place but carrying nothing, so a later run finds
        // the database exactly as disposable as it expects
        await truncateTables().catch(() => undefined)
      }
      await dataSource.destroy()
    }
  })

  beforeEach(async () => {
    await periods.clear()
    await archives.clear()
    await redis.del(...lockKeys)
  })

  it('archives closed periods and leaves the open one in place', async () => {
    await openPeriod({ startAt: new Date(Date.now() - 2 * DAY_MS), endAt: new Date(Date.now() - DAY_MS) })
    const stillOpen = await openPeriod()

    await serviceForBoxState(BoxState.STARTED).archiveUsagePeriods()

    expect(await periods.find()).toEqual([expect.objectContaining({ id: stillOpen.id })])
    expect(await archives.find()).toEqual([
      expect.objectContaining({ boxId: box.id, organizationId: box.organizationId, cpu: box.cpu }),
    ])
  })

  it('rolls a day-old period over, carrying the resources of a running box', async () => {
    await openPeriod({ startAt: new Date(Date.now() - DAY_MS - 60_000) })

    await serviceForBoxState(BoxState.STARTED).closeAndReopenUsagePeriods()

    const [closed, reopened] = await periods.find({ order: { startAt: 'ASC' } })
    expect(closed.endAt).toBeInstanceOf(Date)
    expect(reopened).toEqual(expect.objectContaining({ endAt: null, cpu: 2, gpu: 1, mem: 4, disk: 10 }))
  })

  it('stops charging compute when it rolls over a period whose box is already stopped', async () => {
    // a box that reached STOPPED without passing through STOPPING keeps a
    // full-resource period open; the roll-over must not re-bill its cpu forever
    await openPeriod({ startAt: new Date(Date.now() - DAY_MS - 60_000) })

    await serviceForBoxState(BoxState.STOPPED).closeAndReopenUsagePeriods()

    const [, reopened] = await periods.find({ order: { startAt: 'ASC' } })
    expect(reopened).toEqual(expect.objectContaining({ endAt: null, cpu: 0, gpu: 0, mem: 0, disk: 10 }))
  })

  it('leaves a period younger than a day alone', async () => {
    const fresh = await openPeriod({ startAt: new Date(Date.now() - 60 * 60 * 1000) })

    await serviceForBoxState(BoxState.STARTED).closeAndReopenUsagePeriods()

    expect(await periods.find()).toEqual([expect.objectContaining({ id: fresh.id, endAt: null })])
  })

  it('leaves warm-pool periods alone, since no organization owns them yet', async () => {
    const warmPool = await openPeriod({
      organizationId: BOX_WARM_POOL_UNASSIGNED_ORGANIZATION,
      startAt: new Date(Date.now() - DAY_MS - 60_000),
    })

    await serviceForBoxState(BoxState.STARTED).closeAndReopenUsagePeriods()

    expect(await periods.find()).toEqual([expect.objectContaining({ id: warmPool.id, endAt: null })])
  })

  it('starts the reopened period exactly where the closed one ended, with the same attribution', async () => {
    await openPeriod({ startAt: new Date(Date.now() - DAY_MS - 60_000) })

    await serviceForBoxState(BoxState.STOPPING).closeAndReopenUsagePeriods()

    const [closed, reopened] = await periods.find({ order: { startAt: 'ASC' } })
    // no gap and no overlap: an inherited startAt would bill the elapsed day twice
    expect(reopened.startAt).toEqual(closed.endAt)
    expect(reopened).toEqual(
      expect.objectContaining({ organizationId: box.organizationId, region: box.region, endAt: null }),
    )
  })

  it('closes without reopening when the box row no longer exists', async () => {
    await openPeriod({ startAt: new Date(Date.now() - DAY_MS - 60_000) })
    const serviceWithoutBox = new UsageService(periods, new RedisLockProvider(redis), {
      findOne: async () => null,
    } as any)

    await serviceWithoutBox.closeAndReopenUsagePeriods()

    // a missing box must not throw inside the transaction — that would roll the
    // close back and leave the period accruing forever
    const remaining = await periods.find()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].endAt).toBeInstanceOf(Date)
  })

  it('does not reopen a period for a box that is already gone', async () => {
    await openPeriod({ startAt: new Date(Date.now() - DAY_MS - 60_000) })

    await serviceForBoxState(BoxState.DESTROYED).closeAndReopenUsagePeriods()

    const remaining = await periods.find()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].endAt).toBeInstanceOf(Date)
  })

  it('declares the open-period invariant on the entity as well as in the migration', () => {
    const index = dataSource
      .getMetadata(BoxUsagePeriod)
      .indices.find((candidate) => candidate.name === 'box_usage_periods_one_open_period_per_box_idx')

    expect(index).toMatchObject({ isUnique: true, where: '"endAt" IS NULL' })
    expect(index?.columns.map((column) => column.propertyName)).toEqual(['boxId'])
  })

  it('refuses a second open period for the same box', async () => {
    await openPeriod()

    await expect(openPeriod()).rejects.toThrow(/box_usage_periods_one_open_period_per_box_idx/)
  })
})
