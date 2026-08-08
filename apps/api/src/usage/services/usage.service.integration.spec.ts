/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { createServer, Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { Redis } from 'ioredis'
import { DataSource, Repository } from 'typeorm'
import { BoxState } from '../../box/enums/box-state.enum'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../../box/constants/box.constants'
import { RedisLockProvider } from '../../box/common/redis-lock.provider'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { AddBoxUsagePeriods1785250000000 } from '../../migrations/pre-deploy/1785250000000-add-box-usage-periods-migration'
import { AddBoxUsageExportOutbox1786100000000 } from '../../migrations/pre-deploy/1786100000000-add-box-usage-export-outbox-migration'
import { BoxUsagePeriod } from '../entities/box-usage-period.entity'
import { BoxUsagePeriodArchive } from '../entities/box-usage-period-archive.entity'
import { BoxUsageExportOutbox, UsageExportStatus } from '../entities/box-usage-export-outbox.entity'
import { UsageExportOutboxService } from './usage-export-outbox.service'
import { UsageExportPublisherService } from './usage-export-publisher.service'
import { UsageService } from './usage.service'

// The two cron jobs are a destructive archive transaction and a roll-over that
// rewrites resources — neither is observable without a real database, and the
// at-most-one-open-period invariant lives in a Postgres partial index whose
// WHERE clause no schema differ compares. The schema here is built by running
// the migration, so these tests exercise the DDL that actually ships. Runs only
// when a Postgres and a Redis are reachable; skipped otherwise.
const describeIfDatabase = process.env.DB_HOST && process.env.REDIS_HOST ? describe : describe.skip

const DAY_MS = 24 * 60 * 60 * 1000
const TABLES = ['box_usage_periods', 'box_usage_periods_archive', 'box_usage_export_outbox']

describeIfDatabase('UsageService (integration, real Postgres + Redis)', () => {
  let dataSource: DataSource
  let redis: Redis
  let periods: Repository<BoxUsagePeriod>
  let archives: Repository<BoxUsagePeriodArchive>
  let outboxes: Repository<BoxUsageExportOutbox>
  // Set only once this spec has built the tables itself. Until then the rows in
  // them belong to somebody else and nothing here may write or clear them.
  let ownsTables = false

  const box = { id: 'box-int-1', organizationId: 'org-int-1', region: 'us', cpu: 2, gpu: 1, mem: 4, disk: 10 }

  // The service's own lock keys — cleared individually so a parallel spec
  // sharing this Redis keeps its state.
  const lockKeys = [
    `usage-period-${box.id}`,
    'close-and-reopen-usage-periods',
    'archive-usage-periods',
    'publish-usage-exports',
    'prune-usage-exports',
    'backfill-usage-exports',
  ]

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

  // Export is off by default here, matching a stage that has not enabled it, so
  // the pre-existing ledger tests keep asserting ledger behaviour alone.
  const outboxService = (enabled = false) =>
    new UsageExportOutboxService(outboxes, archives, {
      get: (key: string) => (key === 'usageExport.enabled' ? enabled : 500),
    } as any)

  const serviceForBoxState = (state: BoxState, exportEnabled = false) =>
    new UsageService(
      periods,
      new RedisLockProvider(redis),
      {
        findOne: async () => ({ id: box.id, state }),
      } as any,
      outboxService(exportEnabled),
    )

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
      entities: [BoxUsagePeriod, BoxUsagePeriodArchive, BoxUsageExportOutbox],
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
      await new AddBoxUsageExportOutbox1786100000000().up(queryRunner)
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
    outboxes = dataSource.getRepository(BoxUsageExportOutbox)
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
    await outboxes.clear()
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
    const serviceWithoutBox = new UsageService(
      periods,
      new RedisLockProvider(redis),
      {
        findOne: async () => null,
      } as any,
      outboxService(),
    )

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

  describe('usage export outbox', () => {
    const closedPeriod = (overrides: Partial<BoxUsagePeriod> = {}) =>
      openPeriod({
        startAt: new Date(Date.now() - 2 * DAY_MS),
        endAt: new Date(Date.now() - DAY_MS),
        ...overrides,
      })

    it('records an export intent for each archived period', async () => {
      await closedPeriod()

      await serviceForBoxState(BoxState.STARTED, true).archiveUsagePeriods()

      const [enqueued] = await outboxes.find()
      expect(enqueued).toEqual(
        expect.objectContaining({
          status: UsageExportStatus.PENDING,
          schemaVersion: 1,
          organizationId: box.organizationId,
          boxId: box.id,
          attempts: 0,
        }),
      )
      expect(enqueued.payload).toEqual(expect.objectContaining({ cpu: '2', gpu: '1', mem: '4', disk: '10' }))
      expect(enqueued.eventKey).toHaveLength(64)
    })

    it('writes no export intent while export is disabled', async () => {
      await closedPeriod()

      await serviceForBoxState(BoxState.STARTED).archiveUsagePeriods()

      expect(await archives.find()).toHaveLength(1)
      expect(await outboxes.find()).toHaveLength(0)
    })

    it('excludes warm-pool periods from export', async () => {
      await closedPeriod({ organizationId: BOX_WARM_POOL_UNASSIGNED_ORGANIZATION })

      await serviceForBoxState(BoxState.STARTED, true).archiveUsagePeriods()

      expect(await archives.find()).toHaveLength(1)
      expect(await outboxes.find()).toHaveLength(0)
    })

    // The whole point of sharing the archive transaction: an export intent must
    // never outlive a rolled-back archive, and an archive must never commit
    // without one.
    it('archives nothing when recording the export intent fails', async () => {
      const period = await closedPeriod()
      const failing = new UsageService(
        periods,
        new RedisLockProvider(redis),
        { findOne: async () => ({ id: box.id, state: BoxState.STARTED }) } as any,
        new UsageExportOutboxService(outboxes, archives, {
          get: () => {
            throw new Error('configuration unavailable')
          },
        } as any),
      )

      await expect(failing.archiveUsagePeriods()).rejects.toThrow('configuration unavailable')

      expect(await periods.find()).toEqual([expect.objectContaining({ id: period.id })])
      expect(await archives.find()).toHaveLength(0)
      expect(await outboxes.find()).toHaveLength(0)
    })

    // The live path keys off the live row, the backfill off its archived copy —
    // whose id is different. If the two derivations ever diverged, this second
    // pass would enqueue the same usage again and the customer would be billed
    // twice.
    it('converges with the archive backfill instead of duplicating', async () => {
      await closedPeriod()
      await serviceForBoxState(BoxState.STARTED, true).archiveUsagePeriods()

      const result = await outboxService(true).backfill()

      expect(result.scanned).toBe(1)
      expect(result.enqueued).toBe(0)
      expect(await outboxes.find()).toHaveLength(1)
    })

    // The unique event key is what makes the whole pipeline safe to retry. It
    // must be enforced by the shipped DDL, not merely by the in-memory dedupe.
    it('refuses a second intent for usage it has already recorded', async () => {
      const usagePeriod = await closedPeriod()
      const exporter = outboxService(true)

      await expect(exporter.enqueue(dataSource.manager, [usagePeriod])).resolves.toBe(1)
      await expect(exporter.enqueue(dataSource.manager, [usagePeriod])).resolves.toBe(0)

      expect(await outboxes.find()).toHaveLength(1)
    })

    it('rejects a status the migration does not allow', async () => {
      await expect(
        dataSource.query(
          `INSERT INTO "box_usage_export_outbox" ("eventKey", "payload", "schemaVersion", "status")
           VALUES ('key-bogus', '{}'::jsonb, 1, 'delivering')`,
        ),
      ).rejects.toThrow(/box_usage_export_outbox_status_ck/)
    })

    it('stores a blocked row with no denormalized attribution to trust', async () => {
      await openPeriod({
        startAt: new Date(Date.now() - 2 * DAY_MS),
        endAt: new Date(Date.now() - DAY_MS),
        cpu: Number.NaN,
      })

      await serviceForBoxState(BoxState.STARTED, true).archiveUsagePeriods()

      const [blocked] = await outboxes.find()
      expect(blocked).toEqual(
        expect.objectContaining({
          status: UsageExportStatus.BLOCKED,
          organizationId: null,
          boxId: null,
          startAt: null,
          endAt: null,
        }),
      )
      expect(blocked.lastError).toMatch(/finite/)
    })

    it('backfills archived periods that predate the exporter', async () => {
      await archives.save(
        archives.create({
          boxId: box.id,
          organizationId: box.organizationId,
          region: box.region,
          cpu: box.cpu,
          gpu: box.gpu,
          mem: box.mem,
          disk: box.disk,
          startAt: new Date(Date.now() - 3 * DAY_MS),
          endAt: new Date(Date.now() - 2 * DAY_MS),
        }),
      )

      const result = await outboxService(true).backfill()

      expect(result).toEqual({ scanned: 1, enqueued: 1 })
      expect(await outboxes.find()).toHaveLength(1)
    })

    it('backfills across several pages without duplicating', async () => {
      for (let index = 0; index < 5; index += 1) {
        await archives.save(
          archives.create({
            boxId: `box-page-${index}`,
            organizationId: box.organizationId,
            region: box.region,
            cpu: box.cpu,
            gpu: box.gpu,
            mem: box.mem,
            disk: box.disk,
            startAt: new Date(Date.now() - (index + 2) * DAY_MS),
            endAt: new Date(Date.now() - (index + 1) * DAY_MS),
          }),
        )
      }

      const paged = new UsageExportOutboxService(outboxes, archives, {
        get: (key: string) => (key === 'usageExport.enabled' ? true : 2),
      } as any)

      await expect(paged.backfill()).resolves.toEqual({ scanned: 5, enqueued: 5 })
      await expect(paged.backfill()).resolves.toEqual({ scanned: 5, enqueued: 0 })
      expect(await outboxes.find()).toHaveLength(5)
    })
  })

  describe('usage export delivery', () => {
    let server: Server
    let received: any[]
    let respondWith: { status: number } = { status: 200 }

    const sortedEvents = (events: any[]) =>
      [...events].sort((left, right) => left.eventKey.localeCompare(right.eventKey))

    // TypeORM refuses an empty update criteria, so every row is addressed by the
    // one column they all share.
    const allRows = { schemaVersion: 1 }

    const enqueueRows = async (count: number) => {
      const rows = Array.from({ length: count }, (_, index) => ({
        eventKey: `key-${index}`,
        payload: { eventKey: `key-${index}`, cpu: '2' },
        schemaVersion: 1,
        status: UsageExportStatus.PENDING,
        availableAt: new Date(Date.now() - 1_000),
      }))
      await outboxes.save(outboxes.create(rows))
    }

    const publisher = (overrides: Record<string, unknown> = {}) => {
      const settings: Record<string, unknown> = {
        'usageExport.enabled': true,
        'usageExport.url': `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        'usageExport.token': 'tok-2',
        'usageExport.batchSize': 100,
        'usageExport.timeoutMs': 5_000,
        'usageExport.maxAttempts': 10,
        'usageExport.retentionDays': 30,
        'usageExport.visibilityTimeoutMs': 60_000,
        'usageExport.stallWarningMs': 3_600_000,
        ...overrides,
      }
      return new UsageExportPublisherService(outboxes, outboxService(true), new RedisLockProvider(redis), {
        get: (key: string) => settings[key],
      } as any)
    }

    beforeAll(async () => {
      server = createServer((request, response) => {
        const chunks: Buffer[] = []
        request.on('data', (chunk) => chunks.push(chunk))
        request.on('end', () => {
          received.push({
            url: request.url,
            authorization: request.headers.authorization,
            body: JSON.parse(Buffer.concat(chunks).toString()),
          })
          response.writeHead(respondWith.status, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ accepted: 0, duplicates: 0 }))
        })
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    })

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    beforeEach(() => {
      received = []
      respondWith = { status: 200 }
    })

    it('delivers pending rows to the configured endpoint and retires them', async () => {
      await enqueueRows(2)

      await publisher().publishPendingExports()

      expect(received).toHaveLength(1)
      expect(received[0].url).toBe('/internal/usage-events')
      expect(received[0].authorization).toBe('Bearer tok-2')
      expect(received[0].body.schemaVersion).toBe(1)
      // Order within a batch carries no meaning — the receiving side keys off
      // eventKey — so asserting it would only pin an incidental sort.
      expect(sortedEvents(received[0].body.events)).toEqual([
        { eventKey: 'key-0', cpu: '2' },
        { eventKey: 'key-1', cpu: '2' },
      ])

      const stored = await outboxes.find()
      expect(stored.every((entry) => entry.status === UsageExportStatus.DELIVERED)).toBe(true)
      expect(stored.every((entry) => entry.deliveredAt instanceof Date)).toBe(true)
    })

    // At-least-once delivery is the contract, so a replay has to be both
    // possible and identical — the receiving side deduplicates on these keys.
    it('resends the very same event keys when a batch is replayed', async () => {
      await enqueueRows(2)
      await publisher().publishPendingExports()

      await outboxes.update(allRows, {
        status: UsageExportStatus.PENDING,
        availableAt: new Date(Date.now() - 1_000),
      })
      await publisher().publishPendingExports()

      expect(received).toHaveLength(2)
      expect(sortedEvents(received[1].body.events)).toEqual(sortedEvents(received[0].body.events))
    })

    // The visibility window is what replaces a lease. A claimed batch must be
    // invisible while in flight, and must come back on its own afterwards —
    // that is what keeps a crashed publisher from stranding usage forever.
    it('hides a claimed batch for the visibility window and releases it after', async () => {
      await enqueueRows(1)
      respondWith = { status: 503 }

      await publisher({ 'usageExport.visibilityTimeoutMs': 60_000 }).publishPendingExports()
      expect(received).toHaveLength(1)

      await publisher().publishPendingExports()
      expect(received).toHaveLength(1)

      await outboxes.update(allRows, { availableAt: new Date(Date.now() - 1_000) })
      respondWith = { status: 200 }
      await publisher().publishPendingExports()

      expect(received).toHaveLength(2)
      expect((await outboxes.find())[0].status).toBe(UsageExportStatus.DELIVERED)
    })

    // Claims are exercised directly rather than through publishPendingExports:
    // that takes a Redis lock first, so three concurrent publishers would
    // serialise and exactly one would ever claim, leaving this property untested.
    it('never hands one row to two concurrent claimers', async () => {
      await enqueueRows(20)

      const batches = await Promise.all([
        publisher({ 'usageExport.batchSize': 8 }).claimBatch(),
        publisher({ 'usageExport.batchSize': 8 }).claimBatch(),
        publisher({ 'usageExport.batchSize': 8 }).claimBatch(),
      ])

      const claimed = batches.flat().map((entry) => entry.id)
      expect(claimed.length).toBeGreaterThan(8)
      expect(new Set(claimed).size).toBe(claimed.length)
    })

    // A claim that did not move the row out of the selection window would let
    // the next claimer take it straight back. Sequential on purpose: this pins
    // the visibility bump itself, which the race above cannot isolate.
    it('leaves nothing claimable that an earlier claimer already took', async () => {
      await enqueueRows(5)

      const first = await publisher({ 'usageExport.batchSize': 5 }).claimBatch()
      const second = await publisher({ 'usageExport.batchSize': 5 }).claimBatch()

      expect(first).toHaveLength(5)
      expect(second).toHaveLength(0)
    })

    it('keeps history only for the retention window', async () => {
      await enqueueRows(2)
      await publisher().publishPendingExports()
      await outboxes.update({ eventKey: 'key-0' }, { deliveredAt: new Date(Date.now() - 40 * DAY_MS) })

      await publisher().pruneDeliveredExports()

      expect((await outboxes.find()).map((entry) => entry.eventKey)).toEqual(['key-1'])
    })

    it('never prunes a row that has not been delivered', async () => {
      await enqueueRows(1)
      await outboxes.update(allRows, { createdAt: new Date(Date.now() - 90 * DAY_MS) })

      await publisher().pruneDeliveredExports()

      expect(await outboxes.find()).toHaveLength(1)
    })
  })
})
