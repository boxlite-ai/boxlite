/* Copyright 2026 BoxLite AI. SPDX-License-Identifier: AGPL-3.0 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AnalyticsService } from './analytics.service'
import type { TypedConfigService } from '../../config/typed-config.service'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { DataSource } from 'typeorm'
import { ProductAnalyticsConsent1795420800000 } from '../../migrations/pre-deploy/1795420800000-product-analytics-consent-migration'
import { AnalyticsConsentService } from './analytics-consent.service'

const databaseSuite = process.env.DB_HOST ? describe : describe.skip

databaseSuite('Product analytics consent in PostgreSQL', () => {
  const schema = 'analytics_' + randomUUID().replaceAll('-', '')
  const org = randomUUID()
  let observer: DataSource
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
    await db.query("INSERT INTO \"user\" VALUES ('creator'), ('member')")
    await db.query("INSERT INTO organization VALUES ($1,'creator')", [org])
    await db.query("INSERT INTO organization_user VALUES ($1,'member')", [org])
    consent = new AnalyticsConsentService(db)
  })
  beforeEach(async () => {
    await db.query('TRUNCATE product_analytics_consent')
  })
  afterAll(async () => {
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
    expect(await consent.consoleEnabledFrom('member', org)).toBeNull()
    const first = await consent.decide('creator', true)
    expect(await consent.decide('creator', true)).toEqual(first)
    await delay(3)
    expect(await consent.consoleEnabledFrom('member', org)).toBe(first.decidedAt)
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
    await db.query("UPDATE product_analytics_consent SET notice_version = 0 WHERE user_id = 'creator'")
    expect((await consent.preference('creator')).allowed).toBeNull()
    expect(await consent.dispatch(both, new Date(), send)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })
  it('reserves a database connection during saturation and cancels stalled transfers before later events can send', async () => {
    await consent.decide('member', true)
    await delay(3)
    let count = 0
    let full!: () => void
    const saturated = new Promise<void>((resolve) => {
      full = resolve
    })
    const receiver = createServer((req) => {
      req.resume()
      if (++count === 2) full()
    })
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve))
    const config: Record<string, unknown> = {
      'posthog.apiKey': 'phc_test',
      'posthog.host': 'http://127.0.0.1:' + (receiver.address() as AddressInfo).port,
      'database.pool.max': 3,
    }
    const analytics = new AnalyticsService({ get: (key: string) => config[key] } as TypedConfigService, consent)
    try {
      const record = () =>
        analytics.capture({ event: 'test', distinctId: 'member' }, { users: ['member'], organizations: [] })
      for (let i = 0; i < 64; i++) record()
      await saturated
      expect(await db.query('SELECT 1 AS available')).toEqual([{ available: 1 }])
      await consent.decide('member', false)
      record()
      await analytics.onApplicationShutdown()
      expect(count).toBe(2)
    } finally {
      receiver.closeAllConnections()
      await new Promise<void>((r) => receiver.close(() => r()))
      await analytics.onApplicationShutdown()
    }
  })

  it.each([false, true])('serializes withdrawal with a running transfer (failure %s)', async (fail) => {
    await consent.decide('creator', true)
    await consent.decide('member', true)
    await delay(3)
    let entered!: () => void
    let finish!: () => void
    const start = new Promise<void>((resolve) => {
      entered = resolve
    })
    const barrier = new Promise<void>((resolve) => {
      finish = resolve
    })
    const order: string[] = []
    const delivery = consent
      .dispatch(both, new Date(), async () => {
        entered()
        await barrier
        order.push('finished')
        if (fail) throw Error('transport failed')
      })
      .catch(() => false)
    await start
    const withdrawal = consent.decide('creator', false).then(() => {
      order.push('withdrawn')
    })
    try {
      let waiting = false
      for (let i = 0; i < 100 && !waiting; i++) {
        const [row] = await observer.query(
          'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND cardinality(pg_blocking_pids(pid)) > 0) AS waiting',
          [schema],
        )
        waiting = row.waiting
        if (!waiting) await delay(5)
      }
      expect(waiting).toBe(true)
    } finally {
      finish()
      await Promise.all([delivery, withdrawal])
    }
    expect(order).toEqual(['finished', 'withdrawn'])
    const send = jest.fn(async () => {})
    expect(await consent.dispatch(both, new Date(), send)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })
})
