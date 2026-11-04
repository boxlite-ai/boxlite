/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { AddDomain1792972800000 } from '../../migrations/pre-deploy/1792972800000-add-domain-migration'
import { AddCustomDomainConfig1793764800000 } from '../../migrations/pre-deploy/1793764800000-add-custom-domain-config-migration'
import { CustomDomainService } from './custom-domain.service'
import { CustomDomainWorkerService } from './custom-domain-worker.service'
import { DomainSetupError } from './custom-domain-dns.service'
import { CustomDomainRow } from './custom-domain-policy'

const describeWithDatabase = process.env.DB_HOST ? describe : describe.skip
const org = '00000000-0000-4000-8000-000000000001'
const other = '00000000-0000-4000-8000-000000000002'
const schema = `custom_lifecycle_${randomUUID().replaceAll('-', '')}`

describeWithDatabase('custom domain lifecycle (real Postgres)', () => {
  let db: DataSource
  let domains: CustomDomainService
  let worker: CustomDomainWorkerService
  const subscription = { refresh: jest.fn() }
  const dns = { verify: jest.fn(), verifyTls: jest.fn() }
  const provider = { reconcile: jest.fn() }
  const settings = { enabled: true, trafficHost: 'custom.platform.com', reservedSuffixes: [], edgeIps: ['192.0.2.1'] }
  const config = {
    get: (key: string) =>
      ({
        customDomains: settings,
        'customDomains.enabled': settings.enabled,
        'customDomains.trafficHost': settings.trafficHost,
        'domain.appHost': 'apps.platform.com',
        'proxy.domain': 'proxy.platform.com',
      })[key],
    getOrThrow: (key: string) => config.get(key),
  }

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
      await new AddDomain1792972800000().up(runner)
      await new AddCustomDomainConfig1793764800000().up(runner)
    } finally {
      await runner.release()
    }
    domains = new CustomDomainService(db, config as never, subscription as never)
    worker = new CustomDomainWorkerService(db, config as never, subscription as never, dns as never, provider as never)
  })
  afterAll(async () => {
    if (!db?.isInitialized) return
    try {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`)
    } finally {
      await db.destroy()
    }
  })
  beforeEach(async () => {
    jest.clearAllMocks()
    settings.enabled = true
    await db.query(`TRUNCATE domain, custom_domain_config, custom_domain_subscription, organization`)
    await db.query(`INSERT INTO organization (id) VALUES ($1), ($2)`, [org, other])
    await db.query(
      `INSERT INTO custom_domain_subscription (organization_id, eligible, valid_until)
      VALUES ($1, true, now() + interval '5 minutes'), ($2, true, now() + interval '5 minutes')`,
      [org, other],
    )
    subscription.refresh.mockResolvedValue('active')
    dns.verify.mockResolvedValue(undefined)
    dns.verifyTls.mockResolvedValue(new Date(Date.now() + 3_600_000).toISOString())
    provider.reconcile.mockImplementation(async (row: CustomDomainRow) => ({
      state: row.provider_state,
      phase: 'ready',
      expires: new Date(Date.now() + 3_600_000).toISOString(),
      cleaned: !!row.deleted_at,
    }))
  })

  it('deduplicates drafts within an organization without reserving the global hostname', async () => {
    const [first, duplicate] = await Promise.all([
      domains.create(org, 'App.Example.com.'),
      domains.create(org, 'app.example.com'),
    ])
    expect(duplicate.id).toBe(first.id)
    expect(duplicate.dnsRecords).toEqual(first.dnsRecords)
    const foreign = await domains.create(other, 'app.example.com')
    expect(foreign.id).not.toBe(first.id)
    expect(foreign.dnsRecords[1]).not.toEqual(first.dnsRecords[1])
    expect(await db.query(`SELECT * FROM domain`)).toEqual([])
    await expect(domains.get(other, first.id)).rejects.toMatchObject({ status: 404 })
    await expect(domains.delete(other, first.id)).rejects.toMatchObject({ status: 404 })
  })

  it('denies free organizations and disabled deployments before inserting a draft', async () => {
    subscription.refresh.mockResolvedValue('required')
    await expect(domains.create(org, 'app.example.com')).rejects.toMatchObject({ status: 403 })
    settings.enabled = false
    await expect(domains.create(org, 'app.example.com')).rejects.toMatchObject({ status: 503 })
    expect(await db.query(`SELECT * FROM custom_domain_config`)).toEqual([])
  })

  it('does not claim a name or call GCP on failed DNS proof', async () => {
    const draft = await domains.create(org, 'app.example.com')
    dns.verify.mockRejectedValue(new DomainSetupError('ownership_txt_mismatch', true))
    await worker.reconcileDue()
    expect(await db.query(`SELECT * FROM domain`)).toEqual([])
    expect(provider.reconcile).not.toHaveBeenCalled()
    expect(await domains.get(org, draft.id)).toMatchObject({ ready: false, errorCode: 'ownership_txt_mismatch' })
  })

  it('persists custom ownership without consuming the zero platform allowance and probes TLS', async () => {
    const draft = await domains.create(org, 'app.example.com')
    await db.query(`UPDATE organization SET domain_count_limit = 0`)
    await worker.reconcileDue()
    expect(await domains.get(org, draft.id)).toMatchObject({ ready: true, phase: 'ready' })
    expect(await db.query(`SELECT hostname, kind, organization_id, box_id FROM domain`)).toEqual([
      { hostname: 'app.example.com', kind: 'custom', organization_id: org, box_id: null },
    ])
    expect(dns.verifyTls).toHaveBeenCalledWith('app.example.com')
  })

  it('lets only one organization acquire a globally unique name', async () => {
    await domains.create(org, 'app.example.com')
    await domains.create(other, 'app.example.com')
    await worker.reconcileDue()
    expect(await db.query(`SELECT hostname FROM domain`)).toHaveLength(1)
    expect(provider.reconcile).toHaveBeenCalledTimes(1)
    const configs = await db.query(`SELECT error_code FROM custom_domain_config`)
    expect(configs).toContainEqual({ error_code: 'domain_already_owned' })
  })

  it('renews ready domains from DNS and served TLS without spending cloud read quota', async () => {
    const draft = await domains.create(org, 'app.example.com')
    await worker.reconcileDue()
    provider.reconcile.mockClear()
    await db.query(`UPDATE custom_domain_config SET next_check_at = now()`)
    await worker.reconcileDue()
    expect(provider.reconcile).not.toHaveBeenCalled()
    expect(await domains.get(org, draft.id)).toMatchObject({ ready: true })
    dns.verifyTls.mockRejectedValue(new DomainSetupError('https_not_ready'))
    await db.query(`UPDATE custom_domain_config SET next_check_at = now()`)
    await worker.reconcileDue()
    expect(await domains.get(org, draft.id)).toMatchObject({
      ready: false,
      phase: 'provisioning',
      errorCode: 'https_not_ready',
    })
  })

  it('does not let manual retries bypass provider capacity backoff', async () => {
    const draft = await domains.create(org, 'app.example.com')
    provider.reconcile.mockRejectedValue(new DomainSetupError('provider_capacity_exhausted'))
    await worker.reconcileDue()
    const [before] = await db.query(`SELECT next_check_at FROM custom_domain_config WHERE id = $1`, [draft.id])
    await domains.verify(org, draft.id)
    const [after] = await db.query(`SELECT next_check_at FROM custom_domain_config WHERE id = $1`, [draft.id])
    expect(after.next_check_at).toEqual(before.next_check_at)
    await worker.reconcileDue()
    expect(provider.reconcile).toHaveBeenCalledTimes(1)
  })

  it('bounds two replicas and ignores overlapping ticks without processing a hostname twice', async () => {
    for (let offset = 0; offset < 96; offset += 16) {
      await Promise.all(
        Array.from({ length: 16 }, (_, index) => domains.create(org, `batch-${offset + index}.example.com`)),
      )
    }
    const replica = new CustomDomainWorkerService(
      db,
      config as never,
      subscription as never,
      dns as never,
      provider as never,
    )
    const active = new Set<string>()
    const seen = new Set<string>()
    const duplicates: string[] = []
    let peak = 0
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const bothReplicasEntered = new Promise<void>((resolve) => {
      entered = resolve
    })
    dns.verify.mockImplementation(async (hostname: string) => {
      if (seen.has(hostname)) duplicates.push(hostname)
      seen.add(hostname)
      active.add(hostname)
      peak = Math.max(peak, active.size)
      if (active.size === 16) entered()
      await blocked
      active.delete(hostname)
    })
    const pending = Promise.all([worker.reconcileDue(), worker.reconcileDue(), replica.reconcileDue()])
    let deadline: ReturnType<typeof setTimeout>
    try {
      await Promise.race([
        bothReplicasEntered,
        new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error('Replicas did not enter DNS checks')), 5_000)
        }),
      ])
      expect(active.size).toBe(16)
    } finally {
      clearTimeout(deadline!)
      release()
      await pending
    }
    expect(peak).toBe(16)
    expect(duplicates).toEqual([])
    expect(seen.size).toBe(64)
    expect(await db.query(`SELECT id FROM custom_domain_config WHERE phase = 'ready'`)).toHaveLength(64)
    await Promise.all([worker.reconcileDue(), replica.reconcileDue()])
    expect(seen.size).toBe(96)
    expect(duplicates).toEqual([])
    expect(await db.query(`SELECT id FROM custom_domain_config WHERE phase = 'ready'`)).toHaveLength(96)
  }, 30_000)

  it('rechecks 1000 ready domains across replicas without cloud reads or abandoned leases', async () => {
    const replicas = [
      worker,
      new CustomDomainWorkerService(db, config as never, subscription as never, dns as never, provider as never),
    ]
    for (let offset = 0; offset < 1000; offset += 20) {
      await Promise.all(
        Array.from({ length: 20 }, (_, index) => domains.create(org, `scale-${offset + index}.example.com`)),
      )
    }
    for (let round = 0; round < 16; round++) await Promise.all(replicas.map((replica) => replica.reconcileDue()))
    expect(await db.query(`SELECT id FROM custom_domain_config WHERE phase = 'ready'`)).toHaveLength(1000)
    provider.reconcile.mockClear()
    dns.verify.mockClear()
    dns.verifyTls.mockClear()
    await db.query(`UPDATE custom_domain_config SET next_check_at = now()`)
    for (let round = 0; round < 16; round++) await Promise.all(replicas.map((replica) => replica.reconcileDue()))
    expect(provider.reconcile).not.toHaveBeenCalled()
    expect(dns.verify).toHaveBeenCalledTimes(1000)
    expect(dns.verifyTls).toHaveBeenCalledTimes(1000)
    expect(
      await db.query(`SELECT id FROM custom_domain_config WHERE phase = 'ready'
      AND dns_valid_until > now() AND certificate_valid_until > now() AND lease_owner IS NULL`),
    ).toHaveLength(1000)
  }, 120_000)

  it('rejects a worker publication after its lease is revoked', async () => {
    const draft = await domains.create(org, 'app.example.com')
    let finish!: () => void
    let started!: () => void
    const began = new Promise<void>((resolve) => {
      started = resolve
    })
    provider.reconcile.mockImplementationOnce(async (row: CustomDomainRow) => {
      started()
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return { state: row.provider_state, phase: 'ready', expires: new Date(Date.now() + 60_000).toISOString() }
    })
    const pending = worker.reconcileDue()
    await began
    // This is the state published by a confirmed subscription denial.
    await db.query(`UPDATE custom_domain_config SET lease_owner = NULL, dns_valid_until = '-infinity'`)
    finish()
    await pending
    expect(await domains.get(org, draft.id)).toMatchObject({ ready: false, phase: 'pending_certificate_dns' })
  })

  it('keeps deletion final when a cloud operation returns after the user deletes', async () => {
    const draft = await domains.create(org, 'app.example.com')
    let finish!: () => void
    let started!: () => void
    const began = new Promise<void>((resolve) => {
      started = resolve
    })
    provider.reconcile.mockImplementationOnce(async () => {
      started()
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return {
        state: { certificate: 'late-certificate' },
        phase: 'ready',
        expires: new Date(Date.now() + 60_000).toISOString(),
      }
    })
    const pending = worker.reconcileDue()
    await began
    await domains.delete(org, draft.id)
    finish()
    await pending
    expect(await db.query(`SELECT * FROM domain`)).toEqual([])
    await expect(domains.get(org, draft.id)).rejects.toMatchObject({ status: 404 })
    const [tombstone] = await db.query(`SELECT phase, provider_state FROM custom_domain_config WHERE id = $1`, [
      draft.id,
    ])
    expect(tombstone).toEqual({ phase: 'deleting', provider_state: { certificate: 'late-certificate' } })
    await db.query(`UPDATE custom_domain_config SET next_check_at = now()`)
    await worker.reconcileDue()
    expect(provider.reconcile.mock.calls.at(-1)[0].deleted_at).not.toBeNull()
  })

  it('does not apply old DNS proof after an expired draft rotates its challenge', async () => {
    const draft = await domains.create(org, 'app.example.com')
    let finish!: () => void
    let started!: () => void
    const began = new Promise<void>((resolve) => {
      started = resolve
    })
    dns.verify
      .mockRejectedValue(new DomainSetupError('ownership_txt_mismatch', true))
      .mockImplementationOnce(async () => {
        started()
        await new Promise<void>((resolve) => {
          finish = resolve
        })
      })
    const pending = worker.reconcileDue()
    await began
    await db.query(`UPDATE custom_domain_config SET challenge_expires_at = now() - interval '1 second'`)
    const renewed = await domains.create(org, 'app.example.com')
    expect(renewed.dnsRecords[1]).not.toEqual(draft.dnsRecords[1])
    finish()
    await pending
    expect(provider.reconcile).not.toHaveBeenCalled()
    expect(await db.query(`SELECT * FROM domain`)).toEqual([])
  })
})
