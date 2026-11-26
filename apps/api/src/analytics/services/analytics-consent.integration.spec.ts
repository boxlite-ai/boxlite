/* Copyright 2026 BoxLite AI. SPDX-License-Identifier: AGPL-3.0 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { recordBusinessEvent } from '../../common/utils/business-event.util'
import { AnalyticsService } from './analytics.service'
import type { TypedConfigService } from '../../config/typed-config.service'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import Redis from 'ioredis'
import { DataSource } from 'typeorm'
import { metrics } from '@opentelemetry/api'
import { ProductAnalyticsConsent1795420800000 } from '../../migrations/pre-deploy/1795420800000-product-analytics-consent-migration'
import { analyticsConsentCacheKey, AnalyticsConsentService } from './analytics-consent.service'

const databaseSuite = process.env.DB_HOST ? describe : describe.skip

databaseSuite('Product analytics consent in PostgreSQL', () => {
  const schema = 'analytics_' + randomUUID().replaceAll('-', '')
  const org = randomUUID()
  let observer: DataSource
  let redis: Redis
  let db: DataSource
  let consent: AnalyticsConsentService
  const options = {
    type: 'postgres' as const,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
  }
  const both = { users: ['member'], organizations: [org] }
  beforeAll(async () => {
    observer = await new DataSource(options).initialize()
    await observer.query(`CREATE SCHEMA "${schema}"`)
    db = await new DataSource({
      ...options,
      extra: { max: 3, options: '-c search_path=' + schema, application_name: schema },
    }).initialize()
    await db.query('CREATE TABLE "user" (id varchar PRIMARY KEY)')
    await db.query('CREATE TABLE organization (id uuid PRIMARY KEY, "createdBy" varchar)')
    await db.query('CREATE TABLE organization_user ("organizationId" uuid, "userId" varchar)')
    const runner = db.createQueryRunner()
    try {
      await new ProductAnalyticsConsent1795420800000().up(runner)
    } finally {
      await runner.release()
    }
    await db.query("INSERT INTO \"user\" VALUES ('creator'), ('member'), ('old-notice')")
    await db.query("INSERT INTO organization VALUES ($1,'creator')", [org])
    await db.query("INSERT INTO organization_user VALUES ($1,'member')", [org])
    redis = new Redis({
      host: process.env.REDIS_HOST ?? '127.0.0.1',
      port: Number(process.env.REDIS_PORT ?? 6379),
      keyPrefix: schema + ':',
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      commandTimeout: 1000,
    })
    await redis.connect()
    consent = new AnalyticsConsentService(db, redis)
  })
  beforeEach(async () => {
    await db.query('TRUNCATE product_analytics_consent')
    await redis.del(
      analyticsConsentCacheKey('creator', org),
      analyticsConsentCacheKey('grant', 'creator'),
      analyticsConsentCacheKey('grant', 'member'),
    )
  })
  afterAll(async () => {
    redis?.disconnect()
    if (db?.isInitialized) await db.destroy()
    if (observer?.isInitialized) {
      await observer.query(`DROP SCHEMA "${schema}" CASCADE`)
      await observer.destroy()
    }
  })
  it('requires each distinct subject, including the recorded creator even outside current membership', async () => {
    const send = jest.fn(async () => {})
    const userOnly = { users: ['member'], organizations: [] }
    const orgOnly = { users: [], organizations: [org] }
    expect((await consent.preference('member')).allowed).toBeNull()
    await expect(consent.requireMember('creator', org)).rejects.toThrow('membership')
    await consent.requireMember('member', org)
    expect(await consent.dispatch(both, new Date(), send)).toBe(false)
    await consent.decide('member', true)
    await delay(3)
    expect(await consent.dispatch(userOnly, new Date(), send)).toBe(true)
    expect(await consent.dispatch(orgOnly, new Date(), send)).toBe(false)
    expect(await consent.consolePreference('member', org)).toMatchObject({ allowed: true, enabledFrom: null })
    await expect(consent.consolePreference('creator', org)).rejects.toThrow('membership')
    const first = await consent.decide('creator', true)
    expect(await consent.decide('creator', true)).toEqual(first)
    await delay(3)
    expect((await consent.consolePreference('member', org)).enabledFrom).toBe(first.decidedAt)
    expect(await consent.dispatch(both, new Date(), send)).toBe(true)
    expect(await consent.dispatch({ users: ['creator'], organizations: [org, org] }, new Date(), send)).toBe(true)
    expect(await consent.dispatch({ users: [], organizations: [] }, new Date(), send)).toBe(false)
    expect(await consent.dispatch({ users: ['member'], organizations: [randomUUID()] }, new Date(), send)).toBe(false)
    await consent.decide('member', false)
    expect(await consent.dispatch(both, new Date(), send)).toBe(false)
    expect(await consent.dispatch(orgOnly, new Date(), send)).toBe(true)
    expect(send).toHaveBeenCalledTimes(4)
  })
  it('discards pre-grant events, old notice versions, and events from a previous grant', async () => {
    const send = jest.fn(async () => {})
    const before = new Date()
    await delay(5)
    await consent.decide('creator', true)
    await consent.decide('member', true)
    expect(await consent.dispatch(both, before, send)).toBe(false)
    await delay(5)
    const during = new Date()
    await consent.decide('member', false)
    await delay(5)
    await consent.decide('member', true)
    expect(await consent.dispatch(both, during, send)).toBe(false)
    await db.query(
      "INSERT INTO product_analytics_consent (user_id, allowed, notice_version) VALUES ('old-notice',true,0)",
    )
    expect((await consent.preference('old-notice')).allowed).toBeNull()
    expect(await consent.dispatch({ users: ['old-notice'], organizations: [] }, new Date(), send)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })
  it('shares 30-second decisions and coalesces cold reads during concurrent creates', async () => {
    await consent.decide('creator', true)
    await consent.decide('member', true)
    await delay(3)
    const send = jest.fn(async () => {})
    const reads = jest.spyOn(db, 'query')
    try {
      await Promise.all(Array.from({ length: 32 }, () => consent.dispatch(both, new Date(), send)))
      expect(reads).toHaveBeenCalledTimes(3)
      expect(send).toHaveBeenCalledTimes(32)
      const other = new AnalyticsConsentService(db, redis)
      await other.dispatch(both, new Date(), send)
      expect(send).toHaveBeenCalledTimes(33)
      expect(reads).toHaveBeenCalledTimes(3)
      const key = analyticsConsentCacheKey('grant', 'creator')
      expect(await redis.pttl(key)).toBeGreaterThan(0)
      expect(await redis.pttl(key)).toBeLessThanOrEqual(30_000)
      await db.query("UPDATE product_analytics_consent SET allowed = false WHERE user_id = 'creator'")
      await redis.pexpire(key, 1)
      await delay(5)
      expect(await other.dispatch(both, new Date(), send)).toBe(false)
      reads.mockClear()
      expect(await consent.dispatch(both, new Date(), send)).toBe(false)
      expect(reads).not.toHaveBeenCalled()
    } finally {
      reads.mockRestore()
    }
  })
  it('drops analytics without querying PostgreSQL when Redis is offline', async () => {
    const offline = redis.duplicate({ lazyConnect: true })
    const reads = jest.spyOn(db, 'query')
    const send = jest.fn(async () => {})
    try {
      expect(await new AnalyticsConsentService(db, offline).dispatch(both, new Date(), send)).toBe(false)
      expect(reads).not.toHaveBeenCalled()
      expect(send).not.toHaveBeenCalled()
    } finally {
      offline.disconnect()
      reads.mockRestore()
    }
  })
  it('sends CI webhook usage only when the creator consented before job creation', async () => {
    const received: string[] = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        received.push(body)
        res.writeHead(200).end('{"status":1}')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const config: Record<string, string> = {
      'posthog.apiKey': 'phc_test',
      'posthog.host': 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
    }
    const analytics = new AnalyticsService({ get: (key: string) => config[key] } as TypedConfigService, consent)
    try {
      const before = new Date()
      await delay(5)
      await consent.decide('creator', true)
      await delay(5)
      for (const [correlationId, createdAt] of [
        ['before-grant', before],
        ['after-grant', new Date()],
      ] as const) {
        recordBusinessEvent({
          name: 'cloud.feature.use',
          outcome: 'success',
          organizationId: org,
          correlationId,
          feature: { name: 'ci', evidence: 'runner_started', source: 'api', ciJobCreatedAt: createdAt },
        })
      }
      await analytics.onApplicationShutdown()
      expect(received).toHaveLength(1)
      expect(received[0]).toContain('after-grant')
      expect(received[0]).not.toContain('before-grant')
    } finally {
      await analytics.onApplicationShutdown()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
  it.each([
    [3, 2],
    [2, 1],
    [1, 0],
  ])('limits cold analytics SQL reads for a pool of %i to %i', async (poolSize, limit) => {
    const pool = new DataSource({ ...options, extra: { max: poolSize } })
    const limited = new AnalyticsConsentService(pool, redis)
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let inUse = 0,
      peak = 0
    const read = jest.spyOn(pool, 'query').mockImplementation(async () => {
      inUse++
      peak = Math.max(peak, inUse)
      try {
        await blocked
        return [{ value: '1' }]
      } finally {
        inUse--
      }
    })
    const cache = jest.spyOn(redis, 'get').mockResolvedValue(null)
    const send = jest.fn(async () => {})
    const deliveries = Promise.all(
      Array.from({ length: 6 }, () => limited.dispatch({ users: [randomUUID()], organizations: [] }, new Date(), send)),
    )
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(inUse).toBe(limit)
    } finally {
      release()
      await deliveries
      read.mockRestore()
      cache.mockRestore()
    }
    expect(peak).toBe(limit)
    expect(send).toHaveBeenCalledTimes(limit ? 6 : 0)
  })

  it('admits a warm event while 1000 cold messages share one blocked SQL lookup and counts the excess', async () => {
    const meter = metrics.getMeter('')
    const add = jest.fn()
    jest.spyOn(meter, 'createCounter').mockReturnValue({ add })
    jest.spyOn(metrics, 'getMeter').mockReturnValue(meter)
    const limited = new AnalyticsConsentService(db, redis)
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const read = jest.spyOn(db, 'query').mockImplementation(async () => {
      await blocked
      return [{ value: '1' }]
    })
    const cache = jest
      .spyOn(redis, 'get')
      .mockImplementation(async (key) => (key === analyticsConsentCacheKey('grant', 'warm') ? '1' : null))
    const cold = jest.fn(async () => {})
    const warm = jest.fn(async () => {})
    const at = new Date()
    const dispatch = (id: string, send: () => Promise<void>) =>
      limited.dispatch({ users: [id], organizations: [] }, at, send)
    try {
      const deliveries = Array.from({ length: 1001 }, () => dispatch('cold', cold))
      try {
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(await dispatch('warm', warm)).toBe(true)
        expect(warm).toHaveBeenCalledTimes(1)
        expect(cold).not.toHaveBeenCalled()
        expect(read).toHaveBeenCalledTimes(1)
      } finally {
        release()
        await Promise.all(deliveries)
      }
      expect(cold).toHaveBeenCalledTimes(1000)
      expect(add.mock.calls).toEqual([[1]])
      expect(await dispatch('cold', cold)).toBe(true)
    } finally {
      read.mockRestore()
      cache.mockRestore()
      jest.restoreAllMocks()
    }
  })

  it('allows business queries and checks new consent while an HTTP transfer is stalled', async () => {
    await consent.decide('member', true)
    await delay(3)
    let count = 0
    let full!: () => void
    const saturated = new Promise<void>((resolve) => {
      full = resolve
    })
    const receiver = createServer((req) => {
      req.resume()
      count++
      full()
    })
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve))
    const config: Record<string, unknown> = {
      'posthog.apiKey': 'phc_test',
      'posthog.host': 'http://127.0.0.1:' + (receiver.address() as AddressInfo).port,
    }
    const analytics = new AnalyticsService({ get: (key: string) => config[key] } as TypedConfigService, consent)
    try {
      const record = () =>
        analytics.capture({ event: 'test', distinctId: 'member' }, { users: ['member'], organizations: [] })
      record()
      await saturated
      expect(await db.query('SELECT 1 AS available')).toEqual([{ available: 1 }])
      await consent.decide('member', false)
      record()
      await analytics.onApplicationShutdown()
      expect(count).toBe(1)
    } finally {
      receiver.closeAllConnections()
      await new Promise<void>((r) => receiver.close(() => r()))
      await analytics.onApplicationShutdown()
    }
  })

  it('lets withdrawal finish while an already admitted transfer is still running', async () => {
    await consent.decide('creator', true)
    await consent.decide('member', true)
    await delay(3)
    let entered!: () => void
    let finish!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const barrier = new Promise<void>((resolve) => {
      finish = resolve
    })
    const transfer = consent.dispatch(both, new Date(), async () => {
      entered()
      await barrier
    })
    await started
    const withdrawal = consent.decide('creator', false)
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        withdrawal,
        new Promise((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('withdrawal waited for PostHog')), 1500)
        }),
      ])
      expect(await consent.dispatch(both, new Date(), jest.fn())).toBe(false)
    } finally {
      clearTimeout(timeout)
      finish()
      await Promise.all([transfer, withdrawal])
    }
  })
})
