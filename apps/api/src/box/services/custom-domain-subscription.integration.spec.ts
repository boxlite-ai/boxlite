/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { randomUUID } from 'node:crypto'
import axios from 'axios'
import { DataSource } from 'typeorm'
import { AddCustomDomainConfig1793764800000 } from '../../migrations/pre-deploy/1793764800000-add-custom-domain-config-migration'
import { CustomDomainSubscriptionService } from './custom-domain-subscription.service'

jest.mock('axios')
const get = axios.get as jest.Mock
const describeWithDatabase = process.env.DB_HOST ? describe : describe.skip
const org = '00000000-0000-4000-8000-000000000001'
const schema = `custom_domain_${randomUUID().replaceAll('-', '')}`

describeWithDatabase('custom domain subscription (real Postgres)', () => {
  let db: DataSource
  let service: CustomDomainSubscriptionService
  let billingEnabled = true
  const activePlan = () => ({
    data: {
      plan: {
        status: 'active',
        entitlements: 'active',
        cycleTo: new Date(Date.now() + 3_600_000).toISOString(),
      },
    },
  })

  beforeAll(async () => {
    db = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      extra: { options: `-c search_path=${schema},public` },
    }).initialize()
    await db.query(`CREATE SCHEMA "${schema}"`)
    await db.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`)
    await db.query(`CREATE TABLE organization (id uuid PRIMARY KEY)`)
    const runner = db.createQueryRunner()
    try {
      await new AddCustomDomainConfig1793764800000().up(runner)
    } finally {
      await runner.release()
    }
    service = new CustomDomainSubscriptionService(db, {
      get: (key: string) => {
        if (!billingEnabled) return undefined
        return key === 'billingApiUrl' ? 'https://commerce.example.test' : 'test-service-token'
      },
    } as never)
  })

  afterAll(async () => {
    if (!db?.isInitialized) return
    try {
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    } finally {
      await db.destroy()
    }
  })

  beforeEach(async () => {
    billingEnabled = true
    get.mockReset()
    await db.query(`TRUNCATE custom_domain_subscription, custom_domain_config, organization`)
    await db.query(`INSERT INTO organization (id) VALUES ($1)`, [org])
  })

  it('persists a bounded grant and coalesces repeated refreshes', async () => {
    get.mockResolvedValue(activePlan())
    expect(await service.refresh(org)).toBe('active')
    expect(await service.refresh(org)).toBe('active')
    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith(
      `https://commerce.example.test/organization/${org}/plan`,
      expect.objectContaining({
        timeout: 2000,
        maxRedirects: 0,
        headers: { authorization: 'Bearer test-service-token' },
      }),
    )
    const [row] = await db.query(
      `SELECT extract(epoch FROM valid_until - now()) AS seconds FROM custom_domain_subscription`,
    )
    expect(Number(row.seconds)).toBeGreaterThan(290)
    expect(Number(row.seconds)).toBeLessThanOrEqual(300)
  })

  it('does not extend the old lease on a Commerce outage and denies after expiry', async () => {
    get.mockResolvedValue(activePlan())
    await service.refresh(org)
    const [before] = await db.query(`SELECT valid_until FROM custom_domain_subscription`)
    await db.query(`UPDATE custom_domain_subscription SET checked_at = NULL`)
    get.mockRejectedValue(new Error('timeout'))
    expect(await service.refresh(org)).toBe('active')
    const [after] = await db.query(`SELECT valid_until FROM custom_domain_subscription`)
    expect(after.valid_until).toEqual(before.valid_until)
    await db.query(`UPDATE custom_domain_subscription SET valid_until = now() - interval '1 second', checked_at = NULL`)
    expect(await service.refresh(org)).toBe('unavailable')
  })

  it('caps the grant at five database minutes when the API clock is ahead', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
    try {
      get.mockResolvedValue(activePlan())
      expect(await service.refresh(org)).toBe('active')
      const [row] = await db.query(
        `SELECT extract(epoch FROM valid_until - checked_at) AS seconds FROM custom_domain_subscription`,
      )
      expect(Number(row.seconds)).toBeLessThanOrEqual(300)
    } finally {
      clock.mockRestore()
    }
  })

  it('ends access and invalidates DNS readiness immediately on a suspended entitlement', async () => {
    get.mockResolvedValue(activePlan())
    await service.refresh(org)
    await db.query(
      `INSERT INTO custom_domain_config (organization_id, hostname, challenge, challenge_expires_at,
      dns_valid_until, phase) VALUES ($1, 'app.example.com', 'test-challenge', now() + interval '1 day',
      now() + interval '5 minutes', 'ready')`,
      [org],
    )
    await db.query(`UPDATE custom_domain_subscription SET checked_at = NULL`)
    await db.query(`UPDATE custom_domain_config SET lease_owner = $1, lease_until = now() + interval '2 minutes'`, [
      randomUUID(),
    ])
    get.mockResolvedValue({ data: { plan: { ...activePlan().data.plan, entitlements: 'suspended' } } })
    expect(await service.refresh(org)).toBe('required')
    const [config] = await db.query(`SELECT dns_valid_until > now() AS valid, lease_owner FROM custom_domain_config`)
    expect(config.valid).toBe(false)
    expect(config.lease_owner).toBeNull()
    get.mockResolvedValue(activePlan())
    await db.query(`UPDATE custom_domain_subscription SET checked_at = NULL`)
    expect(await service.refresh(org)).toBe('active')
    const [stillNeedsDns] = await db.query(`SELECT dns_valid_until > now() AS valid FROM custom_domain_config`)
    expect(stillNeedsDns.valid).toBe(false)
  })

  it('rejects a late grant from a worker whose lease expired before a newer denial', async () => {
    let finish!: (value: ReturnType<typeof activePlan>) => void
    let started!: () => void
    const startedRequest = new Promise<void>((resolve) => {
      started = resolve
    })
    get.mockImplementationOnce(() => {
      started()
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    const first = service.refresh(org)
    await startedRequest
    await db.query(`UPDATE custom_domain_subscription SET refresh_until = now() - interval '1 second'`)
    get.mockResolvedValueOnce({ data: {} })
    expect(await service.refresh(org)).toBe('required')
    finish(activePlan())
    expect(await first).toBe('required')
    expect(await service.read(org)).toBe('required')
  })

  it('creates no grant for a removed organization', async () => {
    await db.query(`DELETE FROM organization`)
    expect(await service.refresh(org)).toBe('unavailable')
    expect(get).not.toHaveBeenCalled()
    expect(await db.query(`SELECT * FROM custom_domain_subscription`)).toEqual([])
  })

  it('fails closed when Commerce is not configured', async () => {
    billingEnabled = false
    expect(await service.refresh(org)).toBe('unavailable')
    expect(get).not.toHaveBeenCalled()
  })
})
