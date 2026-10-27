import { randomUUID } from 'crypto'
import { Redis } from 'ioredis'
import { DataSource } from 'typeorm'
import { AuthContext } from '../../common/interfaces/auth-context.interface'
import { AddBoxUsagePeriods1785250000000 } from '../../migrations/pre-deploy/1785250000000-add-box-usage-periods-migration'
import { AddAdminUsageWindowIndexes1792470000000 } from '../../migrations/pre-deploy/1792470000000-add-admin-usage-window-indexes-migration'
import { parseUsageRequest, usageCursor } from '../utils/usage-query'
import { AdminUsageService } from './usage.service'

const describeIfServices = process.env.DB_HOST && process.env.REDIS_HOST ? describe : describe.skip
const schema = `usage_read_${process.pid}_${randomUUID().replaceAll('-', '')}`
const org = '11111111-1111-4111-8111-111111111111'
const otherOrg = '22222222-2222-4222-8222-222222222222'
const auth = { userId: 'synthetic-admin', apiKey: { keyHash: 'synthetic-key-hash' } } as AuthContext
const from = '2026-01-01T00:15:00.000Z'
const to = '2026-01-01T02:30:00.000Z'

describeIfServices('AdminUsageService (real PostgreSQL and Redis)', () => {
  let db: DataSource
  let redis: Redis
  let service: AdminUsageService
  const cacheKeys = new Set<string>()
  const request = (extra: Record<string, unknown> = {}) => parseUsageRequest({ from, to, ...extra })
  const query = async (extra: Record<string, unknown> = {}, principal = auth, owner?: string) => {
    const page = await service.query(request(extra), principal, owner)
    cacheKeys.add(`admin-usage:${page.queryId}`)
    return page
  }
  const period = async (
    fields: {
      start?: string
      end?: string | null
      cpu?: number | string
      mem?: number
      disk?: number
      organizationId?: string
      region?: string
      boxId?: string
    } = {},
    archive = false,
  ) => {
    const table = archive ? 'box_usage_periods_archive' : 'box_usage_periods'
    await db.query(
      `INSERT INTO ${table} ("boxId","organizationId","startAt","endAt",cpu,gpu,mem,disk,region)
       VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8)`,
      [
        fields.boxId ?? 'deleted-box',
        fields.organizationId ?? org,
        fields.start ?? from,
        fields.end === undefined ? to : fields.end,
        fields.cpu ?? 1,
        fields.mem ?? 2,
        fields.disk ?? 3,
        fields.region ?? 'historical-region',
      ],
    )
  }

  beforeAll(async () => {
    db = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema,
      logging: ['error'],
      extra: { options: `-c search_path=${schema},public` },
      migrationsTransactionMode: 'each',
      migrations: [AddBoxUsagePeriods1785250000000, AddAdminUsageWindowIndexes1792470000000],
    }).initialize()
    await db.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`)
    await db.query(`CREATE SCHEMA "${schema}"`)
    await db.runMigrations()
    redis = new Redis({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT || 6379), lazyConnect: true })
    await redis.connect()
    service = new AdminUsageService(db, redis)
  }, 30_000)

  beforeEach(async () => {
    await db.query('TRUNCATE box_usage_periods, box_usage_periods_archive')
  })

  afterAll(async () => {
    if (redis) {
      if (cacheKeys.size) await redis.del(...cacheKeys)
      await redis.quit()
    }
    if (db?.isInitialized) {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`)
      await db.destroy()
    }
  })

  it('integrates live/archive, fractional microseconds, open periods and historic dimensions without Box joins', async () => {
    await period({
      start: '2026-01-01T00:14:59.999900Z',
      end: '2026-01-01T01:15:00.000100Z',
      cpu: 0.5,
      mem: 1.5,
      disk: 0.25,
    })
    await period({ start: '2026-01-01T01:15:00.000100Z', cpu: 0, mem: 0, disk: 0.25 }, true)
    await period({ organizationId: otherOrg, boxId: 'open-box', region: 'previous-region', end: null, cpu: 2 })
    await period({ organizationId: '00000000-0000-0000-0000-000000000000', boxId: 'pool-box', cpu: 1000 })
    const page = await query({
      granularity: 'hour',
      groupBy: 'regionId,organizationId',
      metrics: 'memoryGibSeconds,computeVcpuSeconds,storageByteSeconds',
    })
    expect(page.query.groupBy).toEqual(['organizationId', 'regionId'])
    expect(page.coverage).toEqual({ status: 'unknown', reason: 'usage_events_not_backfilled' })
    const recorded = page.items.filter((item) => item.dimensions.organizationId === org)
    expect(recorded.map(({ from, to }) => [from, to])).toEqual([
      [from, '2026-01-01T01:15:00.000Z'],
      ['2026-01-01T01:15:00.000Z', '2026-01-01T02:15:00.000Z'],
      ['2026-01-01T02:15:00.000Z', to],
    ])
    expect(recorded[0]).toMatchObject({
      dimensions: { organizationId: org, regionId: 'historical-region' },
      sourcePeriodCount: 1,
      values: { computeVcpuSeconds: '1800', memoryGibSeconds: '5400', storageByteSeconds: '966367641600' },
    })
    expect(recorded[1]).toMatchObject({
      sourcePeriodCount: 2,
      values: { computeVcpuSeconds: '0.00005', memoryGibSeconds: '0.00015', storageByteSeconds: '966367641600' },
    })
    expect(recorded[2].values.computeVcpuSeconds).toBe('0')
    expect(
      page.items
        .filter((item) => item.dimensions.organizationId === otherOrg)
        .map((item) => item.values.computeVcpuSeconds),
    ).toEqual(['7200', '7200', '1800'])
    const filtered = await query({
      organizationId: org,
      regionId: 'historical-region',
      boxId: 'deleted-box',
      groupBy: 'boxId',
    })
    expect(filtered.items).toHaveLength(1)
    expect(filtered.items[0].values).toEqual({ computeVcpuSeconds: '1800.00005', storageByteSeconds: '2174327193600' })
  })

  it('distinguishes a recorded zero from a missing group and clips the half-open day/window bounds', async () => {
    await period({ cpu: 0, mem: 0, disk: 0 })
    await period({ start: '2025-12-31T23:00:00Z', end: from }, true)
    await period({ start: to, end: '2026-01-01T03:00:00Z' }, true)
    const page = await query({ granularity: 'day' })
    expect(page.items).toEqual([
      {
        from,
        to,
        dimensions: { organizationId: org },
        values: { computeVcpuSeconds: '0', storageByteSeconds: '0' },
        sourcePeriodCount: 1,
      },
    ])
    expect((await query({ organizationId: otherOrg })).items).toEqual([])
  })

  it('keeps pages fixed across ledger changes, does not renew TTL, and binds identity, owner and query', async () => {
    await period()
    await period({ organizationId: otherOrg })
    const first = await query({ limit: '1' }, auth, 'a'.repeat(64))
    const key = `admin-usage:${first.queryId}`
    await redis.pexpire(key, 60_000)
    const ttl = await redis.pttl(key)
    await db.query('TRUNCATE box_usage_periods, box_usage_periods_archive')
    const continuation = { limit: '1', cursor: first.nextCursor as string }
    const second = await query(continuation, auth, 'a'.repeat(64))
    expect(second.queryId).toBe(first.queryId)
    expect(second.generatedAt).toBe(first.generatedAt)
    expect(second.expiresAt).toBe(first.expiresAt)
    expect(second.items[0].dimensions.organizationId).toBe(otherOrg)
    expect(second.nextCursor).toBeNull()
    expect(await redis.pttl(key)).toBeLessThanOrEqual(ttl)
    expect(await query(continuation, auth, 'a'.repeat(64))).toEqual(second)
    for (const sameUser of [
      { ...auth, apiKey: { ...auth.apiKey, keyHash: 'rotated-key' } },
      { ...auth, apiKey: undefined },
    ]) {
      expect(await query(continuation, sameUser as AuthContext, 'a'.repeat(64))).toEqual(second)
    }
    for (const [extra, principal, owner] of [
      [{ metrics: 'memoryGibSeconds' }, auth, 'a'.repeat(64)],
      [{}, { ...auth, userId: 'other-admin' }, 'a'.repeat(64)],
      [{}, auth, 'b'.repeat(64)],
      [{}, auth, undefined],
    ] as const) {
      await expect(query({ ...continuation, ...extra }, principal, owner)).rejects.toMatchObject({ status: 400 })
    }
    await redis.pexpire(key, 1)
    await new Promise((resolve) => setTimeout(resolve, 10))
    await expect(query(continuation, auth, 'a'.repeat(64))).rejects.toMatchObject({ status: 410 })
    await expect(query({ cursor: usageCursor(randomUUID(), 1) })).rejects.toMatchObject({ status: 410 })
  })

  it('sees one committed copy during an archive move with a new row ID', async () => {
    await period()
    const before = await query()
    const runner = db.createQueryRunner()
    await runner.connect()
    await runner.startTransaction()
    try {
      await runner.query(`INSERT INTO box_usage_periods_archive ("boxId","organizationId","startAt","endAt",cpu,gpu,mem,disk,region)
        SELECT "boxId","organizationId","startAt","endAt",cpu,gpu,mem,disk,region FROM box_usage_periods`)
      await runner.query('DELETE FROM box_usage_periods')
      expect((await query()).items).toEqual(before.items)
      await runner.commitTransaction()
      expect((await query()).items).toEqual(before.items)
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction()
      await runner.release()
    }
  })

  it('treats a malformed cached binding as unavailable rather than a caller mistake', async () => {
    await period()
    await period({ organizationId: otherOrg })
    const first = await query({ limit: '1' })
    const key = `admin-usage:${first.queryId}`
    const stored = JSON.parse((await redis.get(key)) as string)
    delete stored.binding
    await redis.set(key, JSON.stringify(stored), 'EX', 60)
    await expect(query({ limit: '1', cursor: first.nextCursor as string })).rejects.toMatchObject({
      status: 503,
    })
  })

  it('rejects invalid source quantities without returning an empty success', async () => {
    await period({ cpu: 'NaN' })
    await expect(query()).rejects.toMatchObject({ status: 503 })
  })

  it('rejects more than 200000 periods before bucket expansion', async () => {
    await db.query(
      `INSERT INTO box_usage_periods_archive ("boxId","organizationId","startAt","endAt",cpu,gpu,mem,disk,region)
      SELECT 'box', $1, $2::timestamptz, $3::timestamptz, 1,0,1,1,'region' FROM generate_series(1,200001)`,
      [org, from, to],
    )
    await expect(query()).rejects.toMatchObject({ status: 422 })
  }, 30_000)

  it('rejects more than 5000 rows and more than 2 MiB of cached results without truncation', async () => {
    await db.query(
      `INSERT INTO box_usage_periods_archive ("boxId","organizationId","startAt","endAt",cpu,gpu,mem,disk,region)
      SELECT 'box-' || n, $1, $2::timestamptz, $3::timestamptz, 1,0,1,1,'region' FROM generate_series(1,5001) n`,
      [org, from, to],
    )
    await expect(query({ groupBy: 'boxId' })).rejects.toMatchObject({ status: 422 })
    await db.query(`DELETE FROM box_usage_periods_archive WHERE "boxId" = 'box-5001'`)
    await db.query(`UPDATE box_usage_periods_archive SET region = repeat('r', 128), "boxId" = lpad("boxId", 128, 'b')`)
    await expect(
      query({ groupBy: 'boxId,regionId', metrics: 'computeVcpuSeconds,storageByteSeconds,memoryGibSeconds' }),
    ).rejects.toMatchObject({ status: 422 })
  }, 30_000)

  it('times out a blocked statement after five seconds and leaves the pool usable', async () => {
    const runner = db.createQueryRunner()
    await runner.connect()
    await runner.startTransaction()
    try {
      await runner.query('LOCK box_usage_periods IN ACCESS EXCLUSIVE MODE')
      const started = Date.now()
      await expect(query()).rejects.toMatchObject({ status: 503 })
      expect(Date.now() - started).toBeGreaterThanOrEqual(4900)
      expect(Date.now() - started).toBeLessThan(8000)
    } finally {
      await runner.rollbackTransaction()
      await runner.release()
    }
    expect((await query()).items).toEqual([])
  }, 15_000)
})
