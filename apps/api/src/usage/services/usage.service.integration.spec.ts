/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Redis } from 'ioredis'
import { Column, DataSource, Entity, IsNull, PrimaryColumn, Repository } from 'typeorm'
import { BoxState } from '../../box/enums/box-state.enum'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../../box/constants/box.constants'
import { RedisLockProvider } from '../../box/common/redis-lock.provider'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { AddBoxUsagePeriods1785250000000 } from '../../migrations/pre-deploy/1785250000000-add-box-usage-periods-migration'
import { AddBoxUsagePeriodInvariants1786000000000 } from '../../migrations/pre-deploy/1786000000000-add-box-usage-period-invariants-migration'
import { AddBoxBillingTransitionOutbox1786000500000 } from '../../migrations/pre-deploy/1786000500000-add-box-billing-transition-outbox-migration'
import { UnsuspendLegacyPaymentOrganizations1786000600000 } from '../../migrations/pre-deploy/1786000600000-unsuspend-legacy-payment-organizations-migration'
import { ValidateBoxUsagePeriodInvariants1786001000000 } from '../../migrations/post-deploy/1786001000000-validate-box-usage-period-invariants-migration'
import { BoxUsagePeriod } from '../entities/box-usage-period.entity'
import { BoxUsagePeriodArchive } from '../entities/box-usage-period-archive.entity'
import { BoxBillingTransition } from '../entities/box-billing-transition.entity'
import { UsageService } from './usage.service'
import { expectedOpenPeriod } from './expected-usage-period'

// Minimal real table for the box-side anti-join. Keeping this test entity small
// avoids rebuilding the whole application schema while still exercising the
// exact Postgres query used by reconciliation.
@Entity('box')
class ReconciliationBox {
  @PrimaryColumn()
  id: string

  @Column({ type: 'uuid' })
  organizationId: string

  @Column()
  state: BoxState

  @Column()
  desiredState: BoxDesiredState

  @Column({ type: 'float' })
  cpu: number

  @Column({ type: 'float' })
  gpu: number

  @Column({ type: 'float' })
  mem: number

  @Column({ type: 'float' })
  disk: number

  @Column()
  region: string

  @Column({ type: 'uuid', nullable: true })
  runnerId: string | null

  @Column({ default: false })
  pending: boolean

  @Column({ type: 'timestamp with time zone' })
  updatedAt: Date

  @Column({ type: 'timestamp with time zone', nullable: true })
  billingChangedAt: Date | null
}

// The two cron jobs are a destructive archive transaction and a roll-over that
// rewrites resources — neither is observable without a real database, and the
// at-most-one-open-period invariant lives in a Postgres partial index whose
// WHERE clause no schema differ compares. The schema here is built by running
// the migration, so these tests exercise the DDL that actually ships. Runs only
// when a Postgres and a Redis are reachable; skipped otherwise.
const describeIfDatabase = process.env.DB_HOST && process.env.REDIS_HOST ? describe : describe.skip

const DAY_MS = 24 * 60 * 60 * 1000
const TABLES = ['box_billing_transitions', 'box_usage_periods', 'box_usage_periods_archive', 'box']
const TEST_MIGRATIONS_TABLE = 'migrations'
const SETTLED_AGO_MS = 10 * 60 * 1000

describeIfDatabase('UsageService (integration, real Postgres + Redis)', () => {
  let dataSource: DataSource
  let redis: Redis
  let periods: Repository<BoxUsagePeriod>
  let archives: Repository<BoxUsagePeriodArchive>
  let transitions: Repository<BoxBillingTransition>
  // Set only once this spec has built the tables itself. Until then the rows in
  // them belong to somebody else and nothing here may write or clear them.
  let ownsTables = false
  let preMigrationBoundary: { updatedAt: Date; billingChangedAt: Date }
  let recordedMigrationNames: string[]

  const box = {
    id: 'box-int-1',
    organizationId: '5c2f6a48-8f2b-4a1e-9d31-2b7e6f0c1a45',
    region: 'us',
    cpu: 2,
    gpu: 1,
    mem: 4,
    disk: 10,
  }

  // The service's own lock keys — cleared individually so a parallel spec
  // sharing this Redis keeps its state.
  const lockKeys = [
    `usage-period-${box.id}`,
    'close-and-reopen-usage-periods',
    'archive-usage-periods',
    'reconcile-usage-periods',
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

  const serviceForBoxState = (state: BoxState, boxOverrides: Partial<typeof box> = {}) => {
    const service = new UsageService(
      periods,
      new RedisLockProvider(redis),
      { findOne: async () => ({ ...box, state, ...boxOverrides }) } as any,
      { find: async () => [] } as any,
      transitions,
    )
    const closeAndReopenUsagePeriods = service.closeAndReopenUsagePeriods.bind(service)
    service.closeAndReopenUsagePeriods = async () => {
      await insertBox({ state, ...boxOverrides })
      await transitions.update({ boxId: box.id }, { processedAt: new Date() })
      await closeAndReopenUsagePeriods()
    }
    return service
  }

  const openPeriods = () => periods.find({ where: { endAt: IsNull() } })

  const insertBox = async (
    overrides: Partial<typeof box> & {
      state: BoxState
      desiredState?: BoxDesiredState
      runnerId?: string | null
      pending?: boolean
      updatedAtMsAgo?: number
      billingChangedAtMsAgo?: number | null
    },
  ) => {
    const row = {
      ...box,
      runnerId: null,
      desiredState: BoxDesiredState.STARTED,
      pending: false,
      updatedAtMsAgo: SETTLED_AGO_MS,
      billingChangedAtMsAgo: SETTLED_AGO_MS,
      ...overrides,
    }
    const repository = dataSource.getRepository(ReconciliationBox)
    await repository.save({
      id: row.id,
      organizationId: row.organizationId,
      state: row.state,
      desiredState: row.desiredState,
      cpu: row.cpu,
      gpu: row.gpu,
      mem: row.mem,
      disk: row.disk,
      region: row.region,
      runnerId: row.runnerId,
      pending: row.pending,
      updatedAt: new Date(Date.now() - row.updatedAtMsAgo),
      billingChangedAt: row.billingChangedAtMsAgo === null ? null : new Date(Date.now() - row.billingChangedAtMsAgo),
    })
    // BEFORE triggers can replace values passed to save(); re-read the row so
    // assertions use the durable database boundary, not the caller's input.
    return repository.findOneByOrFail({ id: row.id })
  }

  const settleLedger = async (runnerIds: string[] = []) => {
    const service = new UsageService(
      periods,
      new RedisLockProvider(redis),
      dataSource.getRepository(ReconciliationBox) as any,
      { find: async () => runnerIds.map((id) => ({ id })) } as any,
      transitions,
    )
    await service.closeAndReopenUsagePeriods()
    await service.reconcileUsagePeriods()
  }

  const quoted = TABLES.map((table) => `"${table}"`).join(', ')
  const dropTables = () => dataSource.query(`DROP TABLE IF EXISTS "${TEST_MIGRATIONS_TABLE}", ${quoted}`)
  const truncateTables = () => dataSource.query(`TRUNCATE ${quoted}`)

  // This spec owns the ledger tables outright — it drops and rebuilds them from
  // the migration — so it must never be pointed at a database holding real
  // usage. Each table is checked on its own: one populated table is enough to
  // refuse, even if the other is missing.
  const assertDisposableDatabase = async () => {
    const existing: string[] = (
      await dataSource.query(`SELECT table_name FROM information_schema.tables WHERE table_name = ANY($1)`, [
        [TEST_MIGRATIONS_TABLE, ...TABLES],
      ])
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
      entities: [BoxUsagePeriod, BoxUsagePeriodArchive, BoxBillingTransition, ReconciliationBox],
      migrations: [AddBoxBillingTransitionOutbox1786000500000],
      migrationsTransactionMode: 'each',
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
      await queryRunner.query(
        `CREATE TABLE "box" (
          "id" character varying NOT NULL,
          "organizationId" uuid NOT NULL,
          "state" character varying NOT NULL,
          "desiredState" character varying NOT NULL,
          "cpu" double precision NOT NULL,
          "gpu" double precision NOT NULL,
          "mem" double precision NOT NULL,
          "disk" double precision NOT NULL,
          "region" character varying NOT NULL,
          "runnerId" uuid,
          "pending" boolean NOT NULL DEFAULT false,
          "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
          CONSTRAINT "box_test_id_pk" PRIMARY KEY ("id")
        )`,
      )
      await queryRunner.query(`CREATE INDEX "box_test_runner_idx" ON "box" ("runnerId")`)
      const oldUpdatedAt = new Date(Date.now() - DAY_MS)
      await queryRunner.query(
        `INSERT INTO "box" (
           "id", "organizationId", "state", "desiredState", "cpu", "gpu", "mem", "disk",
           "region", "runnerId", "pending", "updatedAt"
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, false, $10)`,
        [
          'box-pre-migration',
          box.organizationId,
          BoxState.STARTED,
          BoxDesiredState.STARTED,
          box.cpu,
          box.gpu,
          box.mem,
          box.disk,
          box.region,
          oldUpdatedAt,
        ],
      )
      await new AddBoxUsagePeriodInvariants1786000000000().up(queryRunner)
      const [boundary] = (await queryRunner.query(
        `SELECT "updatedAt", "billingChangedAt"
           FROM "box"
          WHERE "id" = 'box-pre-migration'`,
      )) as Array<{ updatedAt: Date; billingChangedAt: Date }>
      preMigrationBoundary = boundary

      // Model an environment that deployed the original billing migration
      // before this outbox upgrade existed. TypeORM must see 1786000000000 in
      // history and still discover and execute the later migration.
      await queryRunner.query(`
        CREATE TABLE "migrations" (
          "id" SERIAL NOT NULL,
          "timestamp" bigint NOT NULL,
          "name" character varying NOT NULL,
          CONSTRAINT "migrations_test_id_pk" PRIMARY KEY ("id")
        )
      `)
      await queryRunner.query(`INSERT INTO "migrations" ("timestamp", "name") VALUES ($1, $2)`, [
        1786000000000,
        'AddBoxUsagePeriodInvariants1786000000000',
      ])
      await dataSource.runMigrations({ transaction: 'each' })
      recordedMigrationNames = (
        (await queryRunner.query(`SELECT "name" FROM "migrations" ORDER BY "timestamp"`)) as Array<{
          name: string
        }>
      ).map((migration) => migration.name)
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
    transitions = dataSource.getRepository(BoxBillingTransition)
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
        await dataSource.query(`DROP TABLE IF EXISTS "${TEST_MIGRATIONS_TABLE}"`).catch(() => undefined)
      }
      await dataSource.destroy()
    }
  })

  beforeEach(async () => {
    await truncateTables()
    await redis.del(...lockKeys)
  })

  it('gives pre-migration boxes a safe deployment boundary without copying updatedAt', () => {
    expect(preMigrationBoundary.billingChangedAt).toBeInstanceOf(Date)
    expect(preMigrationBoundary.billingChangedAt.getTime()).toBeGreaterThan(preMigrationBoundary.updatedAt.getTime())
    expect(preMigrationBoundary.billingChangedAt.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it('runs the outbox upgrade after the original billing migration is already recorded', () => {
    expect(recordedMigrationNames).toEqual([
      'AddBoxUsagePeriodInvariants1786000000000',
      'AddBoxBillingTransitionOutbox1786000500000',
    ])
  })

  it('timestamps blocked billing updates only after they acquire the box row lock and preserves id order', async () => {
    await insertBox({ state: BoxState.STARTED })
    await transitions.delete({ boxId: box.id })

    const blocker = dataSource.createQueryRunner()
    const firstUpdater = dataSource.createQueryRunner()
    const secondUpdater = dataSource.createQueryRunner()
    await Promise.all([blocker.connect(), firstUpdater.connect(), secondUpdater.connect()])
    let updates: Promise<unknown>[] = []

    try {
      await blocker.startTransaction()
      await blocker.query(`SELECT "id" FROM "box" WHERE "id" = $1 FOR UPDATE`, [box.id])
      const [{ pid: firstPid }] = (await firstUpdater.query(`SELECT pg_backend_pid() AS pid`)) as Array<{ pid: number }>
      const [{ pid: secondPid }] = (await secondUpdater.query(`SELECT pg_backend_pid() AS pid`)) as Array<{
        pid: number
      }>

      updates = [
        firstUpdater.query(`UPDATE "box" SET "disk" = "disk" + 1 WHERE "id" = $1`, [box.id]),
        secondUpdater.query(`UPDATE "box" SET "disk" = "disk" + 1 WHERE "id" = $1`, [box.id]),
      ]

      let waitingPids: number[] = []
      for (let attempt = 0; attempt < 100; attempt += 1) {
        waitingPids = (
          (await dataSource.query(
            `SELECT pid
               FROM pg_stat_activity
              WHERE pid = ANY($1)
                AND wait_event_type = 'Lock'`,
            [[firstPid, secondPid]],
          )) as Array<{ pid: number }>
        ).map(({ pid }) => pid)
        if (waitingPids.length === 2) {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(waitingPids.sort()).toEqual([firstPid, secondPid].sort())

      const [{ releasedAfter }] = (await blocker.query(`SELECT clock_timestamp() AS "releasedAfter"`)) as Array<{
        releasedAfter: Date
      }>
      await blocker.commitTransaction()
      await Promise.all(updates)

      const captured = await transitions.find({ where: { boxId: box.id }, order: { id: 'ASC' } })
      expect(captured).toHaveLength(2)
      expect(captured[0].occurredAt.getTime()).toBeGreaterThanOrEqual(releasedAfter.getTime())
      expect(captured[1].occurredAt.getTime()).toBeGreaterThanOrEqual(captured[0].occurredAt.getTime())
    } finally {
      if (blocker.isTransactionActive) {
        await blocker.rollbackTransaction()
      }
      await Promise.allSettled(updates)
      await Promise.all([blocker.release(), firstUpdater.release(), secondUpdater.release()])
    }
  })

  it('fails an outbox rollback closed while an unprocessed billing transition remains', async () => {
    await insertBox({ state: BoxState.STARTED })
    const queryRunner = dataSource.createQueryRunner()
    await queryRunner.connect()
    try {
      await expect(new AddBoxBillingTransitionOutbox1786000500000().down(queryRunner)).rejects.toThrow(
        /cannot remove billing transition outbox while unprocessed rows remain/,
      )
    } finally {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction()
      }
      await queryRunner.release()
    }

    const [{ outboxTable, triggerCount }] = (await dataSource.query(`
      SELECT
        to_regclass('box_billing_transitions') AS "outboxTable",
        (
          SELECT count(*)::int
            FROM pg_trigger
           WHERE tgname = 'box_billing_changed_at_trigger'
             AND NOT tgisinternal
        ) AS "triggerCount"
    `)) as Array<{ outboxTable: string | null; triggerCount: number }>
    expect(outboxTable).toBe('box_billing_transitions')
    expect(triggerCount).toBe(1)
    expect(await transitions.countBy({ boxId: box.id, processedAt: IsNull() })).toBe(1)
  })

  it('repairs only organizations suspended by the removed payment-method policy', async () => {
    const queryRunner = dataSource.createQueryRunner()
    await queryRunner.connect()
    await queryRunner.startTransaction()
    try {
      await queryRunner.query(`
        CREATE TEMP TABLE "organization" (
          "id" character varying PRIMARY KEY,
          "suspended" boolean NOT NULL,
          "suspendedAt" TIMESTAMP WITH TIME ZONE,
          "suspensionReason" character varying,
          "suspendedUntil" TIMESTAMP WITH TIME ZONE
        ) ON COMMIT DROP
      `)
      const suspendedAt = new Date('2026-08-06T00:00:00.000Z')
      await queryRunner.query(
        `INSERT INTO "organization" (
           "id", "suspended", "suspendedAt", "suspensionReason", "suspendedUntil"
         ) VALUES
           ('legacy-payment', true, $1, 'Payment method required', $1),
           ('manual-review', true, $1, 'Manual review required', $1),
           ('already-active', false, NULL, 'Payment method required', NULL)`,
        [suspendedAt],
      )

      await new UnsuspendLegacyPaymentOrganizations1786000600000().up(queryRunner)

      const rows = (await queryRunner.query(`SELECT * FROM "organization" ORDER BY "id"`)) as Array<{
        id: string
        suspended: boolean
        suspendedAt: Date | null
        suspensionReason: string | null
        suspendedUntil: Date | null
      }>
      expect(rows).toEqual([
        expect.objectContaining({
          id: 'already-active',
          suspended: false,
          suspensionReason: 'Payment method required',
        }),
        expect.objectContaining({
          id: 'legacy-payment',
          suspended: false,
          suspendedAt: null,
          suspensionReason: null,
          suspendedUntil: null,
        }),
        expect.objectContaining({
          id: 'manual-review',
          suspended: true,
          suspendedAt,
          suspensionReason: 'Manual review required',
          suspendedUntil: suspendedAt,
        }),
      ])
      await queryRunner.commitTransaction()
    } finally {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction()
      }
      await queryRunner.release()
    }
  })

  it('archives closed periods and leaves the open one in place', async () => {
    const closed = await openPeriod({
      startAt: new Date(Date.now() - 2 * DAY_MS),
      endAt: new Date(Date.now() - DAY_MS),
    })
    const stillOpen = await openPeriod()

    await serviceForBoxState(BoxState.STARTED).archiveUsagePeriods()

    expect(await periods.find()).toEqual([expect.objectContaining({ id: stillOpen.id })])
    expect(await archives.find()).toEqual([
      expect.objectContaining({
        sourceUsagePeriodId: closed.id,
        boxId: box.id,
        organizationId: box.organizationId,
        cpu: box.cpu,
      }),
    ])
  })

  it('archives distinct zero-duration periods that share the same box and millisecond', async () => {
    const boundary = new Date(Date.now() - DAY_MS)
    const first = await openPeriod({ startAt: boundary, endAt: boundary })
    const second = await openPeriod({ startAt: boundary, endAt: boundary })

    await serviceForBoxState(BoxState.STARTED).archiveUsagePeriods()

    expect(await periods.find()).toHaveLength(0)
    expect((await archives.find()).map((row) => row.sourceUsagePeriodId).sort()).toEqual([first.id, second.id].sort())
  })

  it('finishes an idempotent retry only after the existing archive snapshot matches', async () => {
    const source = await openPeriod({
      startAt: new Date(Date.now() - 2 * DAY_MS),
      endAt: new Date(Date.now() - DAY_MS),
    })
    await archives.save(BoxUsagePeriodArchive.fromUsagePeriod(source))

    await serviceForBoxState(BoxState.STARTED).archiveUsagePeriods()

    await expect(periods.findOneBy({ id: source.id })).resolves.toBeNull()
    expect(await archives.countBy({ sourceUsagePeriodId: source.id })).toBe(1)
  })

  it('keeps a divergent source conflict but still archives later rows in the batch', async () => {
    const poison = await openPeriod({
      startAt: new Date(Date.now() - 3 * DAY_MS),
      endAt: new Date(Date.now() - 2 * DAY_MS),
    })
    const later = await openPeriod({
      startAt: new Date(Date.now() - 2 * DAY_MS),
      endAt: new Date(Date.now() - DAY_MS),
    })
    const divergent = BoxUsagePeriodArchive.fromUsagePeriod(poison)
    divergent.cpu += 1
    await archives.save(divergent)

    await expect(serviceForBoxState(BoxState.STARTED).archiveUsagePeriods()).rejects.toThrow(
      new RegExp(`Failed to archive 1 usage period.*${poison.id}`),
    )

    await expect(periods.findOneBy({ id: poison.id })).resolves.toEqual(expect.objectContaining({ id: poison.id }))
    await expect(periods.findOneBy({ id: later.id })).resolves.toBeNull()
    expect(await archives.countBy({ sourceUsagePeriodId: poison.id })).toBe(1)
    expect(await archives.countBy({ sourceUsagePeriodId: later.id })).toBe(1)
  })

  it('defers historical check scans until the explicit post-deploy validator', async () => {
    const constraintNames = [
      'box_usage_periods_end_after_start_check',
      'box_usage_periods_archive_end_after_start_check',
    ]
    const before = (await dataSource.query(
      `SELECT conname, convalidated
         FROM pg_constraint
        WHERE conname = ANY($1)
        ORDER BY conname`,
      [constraintNames],
    )) as Array<{ conname: string; convalidated: boolean }>
    expect(before).toHaveLength(2)
    expect(before.every((constraint) => constraint.convalidated === false)).toBe(true)

    const queryRunner = dataSource.createQueryRunner()
    await queryRunner.connect()
    await queryRunner.startTransaction()
    try {
      await new ValidateBoxUsagePeriodInvariants1786001000000().up(queryRunner)
      await queryRunner.commitTransaction()
    } catch (error) {
      await queryRunner.rollbackTransaction()
      throw error
    } finally {
      await queryRunner.release()
    }

    const after = (await dataSource.query(
      `SELECT conname, convalidated
         FROM pg_constraint
        WHERE conname = ANY($1)
        ORDER BY conname`,
      [constraintNames],
    )) as Array<{ conname: string; convalidated: boolean }>
    expect(after).toHaveLength(2)
    expect(after.every((constraint) => constraint.convalidated === true)).toBe(true)
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
      { findOne: async () => null } as any,
      { find: async () => [] } as any,
      transitions,
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

  describe('box state versus the open period', () => {
    it('replays lost STARTED then STOPPING boundaries in order and only once', async () => {
      await insertBox({ state: BoxState.STARTED })
      await dataSource.query(`UPDATE "box" SET "state" = $1 WHERE "id" = $2`, [BoxState.STOPPING, box.id])

      const captured = await transitions.find({ where: { boxId: box.id }, order: { id: 'ASC' } })
      expect(captured.map((transition) => transition.state)).toEqual([BoxState.STARTED, BoxState.STOPPING])
      const startedAt = new Date('2026-08-06T00:00:00.000Z')
      const stoppingAt = new Date('2026-08-06T00:05:00.000Z')
      captured[0].occurredAt = startedAt
      captured[1].occurredAt = stoppingAt
      await transitions.save(captured)

      await settleLedger()

      const firstPass = await periods.find({ where: { boxId: box.id }, order: { startAt: 'ASC' } })
      expect(firstPass).toEqual([
        expect.objectContaining({
          boxId: box.id,
          startAt: startedAt,
          endAt: stoppingAt,
          cpu: box.cpu,
          gpu: box.gpu,
          mem: box.mem,
          disk: box.disk,
        }),
        expect.objectContaining({
          boxId: box.id,
          startAt: stoppingAt,
          endAt: null,
          cpu: 0,
          gpu: 0,
          mem: 0,
          disk: box.disk,
        }),
      ])
      expect((await transitions.findBy({ boxId: box.id })).every((transition) => transition.processedAt)).toBe(true)

      await settleLedger()

      expect(await periods.find({ where: { boxId: box.id }, order: { startAt: 'ASC' } })).toEqual(firstPass)
    })

    it('closes billing at a pending desired-destroy boundary', async () => {
      await insertBox({ state: BoxState.STARTED })
      await dataSource.query(
        `UPDATE "box"
            SET "desiredState" = $1, "pending" = true
          WHERE "id" = $2`,
        [BoxDesiredState.DESTROYED, box.id],
      )

      const captured = await transitions.find({ where: { boxId: box.id }, order: { id: 'ASC' } })
      expect(captured).toHaveLength(2)
      expect(captured[1]).toEqual(expect.objectContaining({ desiredState: BoxDesiredState.DESTROYED, pending: true }))
      const startedAt = new Date('2026-08-06T01:00:00.000Z')
      const destroyRequestedAt = new Date('2026-08-06T01:05:00.000Z')
      captured[0].occurredAt = startedAt
      captured[1].occurredAt = destroyRequestedAt
      await transitions.save(captured)

      await settleLedger()

      expect(await openPeriods()).toHaveLength(0)
      expect(await periods.find({ where: { boxId: box.id } })).toEqual([
        expect.objectContaining({
          startAt: startedAt,
          endAt: destroyRequestedAt,
          cpu: box.cpu,
        }),
      ])
    })

    it('opens a full-resource period when the STARTED event was lost', async () => {
      const started = await insertBox({ state: BoxState.STARTED })

      await settleLedger()

      expect(await openPeriods()).toEqual([
        expect.objectContaining({
          boxId: box.id,
          organizationId: box.organizationId,
          cpu: box.cpu,
          gpu: box.gpu,
          mem: box.mem,
          disk: box.disk,
          startAt: started.billingChangedAt,
        }),
      ])
    })

    it('replaces a stale running period with the current resource shape', async () => {
      const resized = await insertBox({ state: BoxState.STARTED, disk: 100 })
      const stale = await openPeriod({
        cpu: 0,
        gpu: 0,
        mem: 0,
        disk: 10,
        startAt: new Date(resized.billingChangedAt.getTime() - 60_000),
      })

      await settleLedger()

      const closed = await periods.findOneByOrFail({ id: stale.id })
      const repaired = await periods.findOne({ where: { endAt: IsNull() } })
      expect(closed.endAt).toEqual(resized.billingChangedAt)
      expect(repaired?.startAt).toEqual(resized.billingChangedAt)
      expect(repaired).toEqual(expect.objectContaining({ cpu: box.cpu, gpu: box.gpu, mem: box.mem, disk: 100 }))
    })

    it('does not move the billing boundary when an unrelated write only advances updatedAt', async () => {
      const resized = await insertBox({ state: BoxState.STARTED, disk: 100 })
      const billingChangedAt = resized.billingChangedAt
      const stale = await openPeriod({
        cpu: 0,
        gpu: 0,
        mem: 0,
        disk: 10,
        startAt: new Date(billingChangedAt.getTime() - 60_000),
      })
      const unrelatedUpdatedAt = new Date()

      await dataSource.query(`UPDATE "box" SET "updatedAt" = $1 WHERE "id" = $2`, [unrelatedUpdatedAt, box.id])

      const afterUnrelatedWrite = await dataSource.getRepository(ReconciliationBox).findOneByOrFail({ id: box.id })
      expect(afterUnrelatedWrite.updatedAt).toEqual(unrelatedUpdatedAt)
      expect(afterUnrelatedWrite.billingChangedAt).toEqual(billingChangedAt)

      await settleLedger()

      const closed = await periods.findOneByOrFail({ id: stale.id })
      const repaired = await periods.findOne({ where: { endAt: IsNull() } })
      expect(closed.endAt).toEqual(billingChangedAt)
      expect(repaired?.startAt).toEqual(billingChangedAt)
      expect(repaired).toEqual(expect.objectContaining({ disk: 100 }))
    })

    it('captures a billing-relevant raw SQL update even when updatedAt is untouched', async () => {
      const before = await insertBox({ state: BoxState.STARTED })

      const [[after]] = (await dataSource.query(
        `UPDATE "box"
            SET "disk" = "disk" + 1
          WHERE "id" = $1
          RETURNING "disk", "updatedAt", "billingChangedAt"`,
        [box.id],
      )) as [Array<{ disk: number; updatedAt: Date; billingChangedAt: Date }>, number]

      expect(after.disk).toBe(before.disk + 1)
      expect(after.updatedAt).toEqual(before.updatedAt)
      expect(after.billingChangedAt.getTime()).toBeGreaterThan(before.billingChangedAt.getTime())
    })

    it('repairs an explicit null boundary at observation time without consulting updatedAt', async () => {
      await insertBox({ state: BoxState.STARTED })
      await transitions.delete({ boxId: box.id })
      await dataSource.query(`ALTER TABLE "box" DISABLE TRIGGER "box_billing_changed_at_trigger"`)
      try {
        await dataSource.query(`UPDATE "box" SET "billingChangedAt" = NULL WHERE "id" = $1`, [box.id])
      } finally {
        await dataSource.query(`ALTER TABLE "box" ENABLE TRIGGER "box_billing_changed_at_trigger"`)
      }
      const explicitNull = await dataSource.getRepository(ReconciliationBox).findOneByOrFail({ id: box.id })
      const observedBefore = Date.now()

      await settleLedger()

      const [repaired] = await openPeriods()
      expect(explicitNull.billingChangedAt).toBeNull()
      expect(repaired.startAt.getTime()).toBeGreaterThanOrEqual(observedBefore)
      expect(repaired.startAt.getTime()).toBeLessThanOrEqual(Date.now())
      expect(repaired.startAt).not.toEqual(explicitNull.updatedAt)
    })

    it('closes a period whose box has reached a terminal state', async () => {
      const destroyed = await insertBox({ state: BoxState.DESTROYED })
      const open = await openPeriod({ startAt: new Date(destroyed.billingChangedAt.getTime() - 60_000) })

      await settleLedger()

      expect(await openPeriods()).toHaveLength(0)
      expect((await periods.findOneByOrFail({ id: open.id })).endAt).toEqual(destroyed.billingChangedAt)
    })

    it('does not close a period before its start when the durable box timestamp is older', async () => {
      const destroyed = await insertBox({ state: BoxState.DESTROYED })
      const periodStartAt = new Date(destroyed.billingChangedAt.getTime() + 60_000)
      const open = await openPeriod({ startAt: periodStartAt })

      await settleLedger()

      expect((await periods.findOneByOrFail({ id: open.id })).endAt).toEqual(periodStartAt)
    })

    it('applies durable boundaries without waiting for freshness or pending-state drift scans', async () => {
      await insertBox({ id: 'box-fresh', state: BoxState.STARTED, billingChangedAtMsAgo: 0 })
      await insertBox({ id: 'box-pending', state: BoxState.STARTED, pending: true })

      await settleLedger()

      expect(await openPeriods()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ boxId: 'box-fresh', cpu: box.cpu }),
          expect.objectContaining({ boxId: 'box-pending', cpu: box.cpu }),
        ]),
      )
    })

    it('closes any accidental billing period for an unassigned warm-pool box', async () => {
      await insertBox({
        state: BoxState.STARTED,
        organizationId: BOX_WARM_POOL_UNASSIGNED_ORGANIZATION,
      })
      const held = await openPeriod({
        organizationId: BOX_WARM_POOL_UNASSIGNED_ORGANIZATION,
        cpu: 0,
        gpu: 0,
        mem: 0,
      })

      await settleLedger()

      expect(await openPeriods()).toHaveLength(0)
      expect(await periods.findOneByOrFail({ id: held.id })).toEqual(
        expect.objectContaining({ id: held.id, cpu: 0, endAt: expect.any(Date) }),
      )
    })

    it('reaches both assigned-runner and unassigned-runner shards', async () => {
      const runnerId = 'b41f1d0e-9c3a-4f77-8a2d-6e5b3c1d0af2'
      await insertBox({ id: 'box-assigned', state: BoxState.STARTED, runnerId })
      await insertBox({ id: 'box-unassigned', state: BoxState.STOPPED })

      await settleLedger([runnerId])

      const open = await openPeriods()
      expect(open).toHaveLength(2)
      expect(open).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ boxId: 'box-assigned', cpu: box.cpu }),
          expect.objectContaining({ boxId: 'box-unassigned', cpu: 0, disk: box.disk }),
        ]),
      )
    })

    it.each(Object.values(BoxState))('agrees with the shared billing rule for %s', async (state) => {
      await insertBox({ state })

      await settleLedger()

      const expected = expectedOpenPeriod({ ...box, state })
      const open = await openPeriods()
      if (expected === null) {
        expect(open).toHaveLength(0)
      } else {
        expect(open).toEqual([expect.objectContaining(expected)])
      }
    })
  })

  it('declares the open-period invariant on the entity as well as in the migration', () => {
    const index = dataSource
      .getMetadata(BoxUsagePeriod)
      .indices.find((candidate) => candidate.name === 'box_usage_periods_one_open_period_per_box_idx')

    expect(index).toMatchObject({ isUnique: true, where: '"endAt" IS NULL' })
    expect(index?.columns.map((column) => column.propertyName)).toEqual(['boxId'])
  })

  it('declares archive idempotency and time-order checks on entity metadata', () => {
    const archiveMetadata = dataSource.getMetadata(BoxUsagePeriodArchive)
    const archiveIndex = archiveMetadata.indices.find(
      (candidate) => candidate.name === 'box_usage_periods_archive_source_period_uidx',
    )

    expect(archiveIndex).toMatchObject({ isUnique: true, where: '"sourceUsagePeriodId" IS NOT NULL' })
    expect(archiveIndex?.columns.map((column) => column.propertyName)).toEqual(['sourceUsagePeriodId'])
    expect(archiveMetadata.checks.map((check) => check.name)).toContain(
      'box_usage_periods_archive_end_after_start_check',
    )
    expect(dataSource.getMetadata(BoxUsagePeriod).checks.map((check) => check.name)).toContain(
      'box_usage_periods_end_after_start_check',
    )
  })

  it('refuses a second open period for the same box', async () => {
    await openPeriod()

    await expect(openPeriod()).rejects.toThrow(/box_usage_periods_one_open_period_per_box_idx/)
  })

  it('refuses duplicate source UUIDs without conflating equal timestamps', async () => {
    const startAt = new Date(Date.now() - DAY_MS)
    const archived = archives.create({
      sourceUsagePeriodId: '10000000-0000-0000-0000-000000000001',
      boxId: box.id,
      organizationId: box.organizationId,
      region: box.region,
      cpu: box.cpu,
      gpu: box.gpu,
      mem: box.mem,
      disk: box.disk,
      startAt,
      endAt: new Date(),
    })
    await archives.save(archived)

    const duplicate = archives.create({
      sourceUsagePeriodId: archived.sourceUsagePeriodId,
      boxId: archived.boxId,
      organizationId: archived.organizationId,
      region: archived.region,
      cpu: archived.cpu,
      gpu: archived.gpu,
      mem: archived.mem,
      disk: archived.disk,
      startAt: archived.startAt,
      endAt: archived.endAt,
    })
    await expect(archives.save(duplicate)).rejects.toThrow(/box_usage_periods_archive_source_period_uidx/)

    const distinct = archives.create({
      ...duplicate,
      id: undefined,
      sourceUsagePeriodId: '10000000-0000-0000-0000-000000000002',
    })
    await expect(archives.save(distinct)).resolves.toEqual(
      expect.objectContaining({ sourceUsagePeriodId: distinct.sourceUsagePeriodId }),
    )
  })

  it('refuses periods whose end precedes their start', async () => {
    const startAt = new Date()
    const endAt = new Date(startAt.getTime() - 1)

    await expect(openPeriod({ startAt, endAt })).rejects.toThrow(/box_usage_periods_end_after_start_check/)
    await expect(
      archives.save(
        archives.create({
          boxId: box.id,
          organizationId: box.organizationId,
          region: box.region,
          cpu: box.cpu,
          gpu: box.gpu,
          mem: box.mem,
          disk: box.disk,
          startAt,
          endAt,
        }),
      ),
    ).rejects.toThrow(/box_usage_periods_archive_end_after_start_check/)
  })
})
