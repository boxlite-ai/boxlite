/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { AddDomain1792972800000 } from '../../migrations/pre-deploy/1792972800000-add-domain-migration'
import { AddCustomDomainConfig1793764800000 } from '../../migrations/pre-deploy/1793764800000-add-custom-domain-config-migration'
import { RequestDrivenCustomDomains1794398400000 } from '../../migrations/pre-deploy/1794398400000-request-driven-custom-domains-migration'
import { CustomDomainService } from './custom-domain.service'
import { CustomDomainWorkflowService } from './custom-domain-workflow.service'
import { DomainSetupError } from './custom-domain-dns.service'
import { CustomDomainRow } from './custom-domain-policy'

const describeWithDatabase = process.env.DB_HOST ? describe : describe.skip
const org = '00000000-0000-4000-8000-000000000001'
const other = '00000000-0000-4000-8000-000000000002'
const schema = `custom_lifecycle_${randomUUID().replaceAll('-', '')}`

describeWithDatabase('confirmed custom domain lifecycle (real Postgres)', () => {
  let db: DataSource
  let domains: CustomDomainService
  let workflow: CustomDomainWorkflowService
  let migrated: any[]
  const subscription = { refresh: jest.fn(), read: jest.fn() }
  const dns = { checkAll: jest.fn(), verifyTls: jest.fn() }
  const provider = { reconcile: jest.fn() }
  const settings = { enabled: true, trafficHost: 'custom.platform.com' }
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
  const records = (hostname: string) => ({ name: `_acme.${hostname}`, type: 'CNAME', value: 'auth.google.test.' })
  async function cloud(row: CustomDomainRow, mode: string) {
    if (row.deleted_at) return { state: row.provider_state, phase: 'deleting', expires: null, cleaned: true }
    if (mode === 'prepare')
      return {
        state: { ...row.provider_state, authorizationRecord: records(row.hostname), progress: 'awaiting_dns' },
        phase: 'pending_certificate_dns',
        expires: null,
        cleaned: false,
      }
    if (!row.provider_state.certificateSubmitted)
      return {
        state: { ...row.provider_state, certificateSubmitted: true, progress: 'certificate_pending' },
        phase: 'provisioning',
        expires: null,
        cleaned: false,
      }
    return {
      state: { ...row.provider_state, progress: 'tls_pending', certificateState: 'ACTIVE' },
      phase: 'ready',
      expires: '2030-01-01T00:00:00Z',
      cleaned: false,
    }
  }
  async function due(id: string) {
    await db.query(`UPDATE custom_domain_config SET next_check_at = '-infinity' WHERE id = $1`, [id])
  }
  async function ready(owner = org, hostname = 'app.example.com') {
    const draft = await domains.create(owner, hostname)
    await domains.verify(owner, draft.id)
    await due(draft.id)
    await domains.advance(owner, draft.id)
    return domains.get(owner, draft.id)
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
      await runner.query(
        `INSERT INTO custom_domain_config (organization_id, hostname, challenge, challenge_expires_at, phase, error_code)
        VALUES ($1, 'old-ready.example.com', 'old', now(), 'ready', NULL),
        ($1, 'old-invalid.example.com', 'old', now(), 'ready', 'ownership_txt_mismatch'),
        ($1, 'old-pending.example.com', 'old', now(), 'provisioning', NULL)`,
        [org],
      )
      await new RequestDrivenCustomDomains1794398400000().up(runner)
      migrated = await runner.query(
        `SELECT hostname, phase, confirmed_at, certificate_expires_at FROM custom_domain_config ORDER BY hostname`,
      )
    } finally {
      await runner.release()
    }
    workflow = new CustomDomainWorkflowService(
      db,
      config as never,
      subscription as never,
      dns as never,
      provider as never,
    )
    domains = new CustomDomainService(db, config as never, subscription as never, workflow)
  })
  afterAll(async () => {
    if (db?.isInitialized) {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`)
      await db.destroy()
    }
  })
  beforeEach(async () => {
    jest.resetAllMocks()
    settings.enabled = true
    await db.query(`TRUNCATE domain, custom_domain_config, organization`)
    await db.query(`INSERT INTO organization (id) VALUES ($1), ($2)`, [org, other])
    subscription.refresh.mockResolvedValue({ status: 'active', expiresAt: Date.now() + 60_000 })
    subscription.read.mockImplementation(() => subscription.refresh.getMockImplementation()!())
    dns.checkAll.mockResolvedValue(
      ['ownership', 'traffic', 'certificate'].map((record) => ({ record, status: 'passed' })),
    )
    dns.verifyTls.mockResolvedValue('2030-01-01T00:00:00Z')
    provider.reconcile.mockImplementation(cloud)
  })

  it('migrates completed setups without trusting capped expiry or reactivating failed ownership', () => {
    expect(migrated[0]).toMatchObject({
      hostname: 'old-invalid.example.com',
      phase: 'pending_verification',
      confirmed_at: null,
      certificate_expires_at: null,
    })
    expect(migrated[1]).toMatchObject({ hostname: 'old-pending.example.com', confirmed_at: null })
    expect(migrated[2]).toMatchObject({
      hostname: 'old-ready.example.com',
      phase: 'ready',
      confirmed_at: expect.any(Date),
      certificate_expires_at: null,
    })
  })

  it('prepares all three records once without checking DNS, submitting a certificate or rotating expired TXT', async () => {
    const draft = await domains.create(org, 'app.example.com')
    expect(draft.dnsRecords).toHaveLength(3)
    expect(draft.confirmed).toBe(false)
    expect(draft.submissionStatus).toBe('not_submitted')
    expect(dns.checkAll).not.toHaveBeenCalled()
    expect(provider.reconcile.mock.calls.every(([, mode]) => mode === 'prepare')).toBe(true)
    await db.query(`UPDATE custom_domain_config SET challenge_expires_at = now() - interval '1 day'`)
    expect((await domains.create(org, 'app.example.com')).dnsRecords).toEqual(draft.dnsRecords)
    provider.reconcile.mockClear()
    subscription.refresh.mockClear()
    await domains.list(org)
    await domains.get(org, draft.id)
    expect(subscription.refresh).not.toHaveBeenCalled()
    expect(provider.reconcile).not.toHaveBeenCalled()
    expect(dns.checkAll).not.toHaveBeenCalled()
  })

  it.each(['ownership', 'traffic', 'certificate'])(
    'keeps the draft and does not claim or submit when %s fails',
    async (record) => {
      const draft = await domains.create(org, 'app.example.com')
      dns.checkAll.mockResolvedValue([{ record, status: 'failed', errorCode: `${record}_mismatch` }])
      provider.reconcile.mockClear()
      const result = await domains.verify(org, draft.id)
      expect(result.errorCode).toBe(`${record}_mismatch`)
      expect(result.confirmed).toBe(false)
      expect(result.dnsRecords).toEqual(draft.dnsRecords)
      expect(await db.query(`SELECT * FROM domain`)).toEqual([])
      expect(provider.reconcile).not.toHaveBeenCalled()
    },
  )

  it('does not accept an advance call as user confirmation', async () => {
    const draft = await domains.create(org, 'app.example.com')
    await due(draft.id)
    expect(await domains.advance(org, draft.id)).toMatchObject({ confirmed: false, errorCode: 'confirmation_required' })
    expect(dns.checkAll).not.toHaveBeenCalled()
  })

  it('persists confirmation before submission and publishes ready only after a later TLS check', async () => {
    const draft = await domains.create(org, 'app.example.com')
    provider.reconcile.mockImplementation(async (row, mode) => {
      const [saved] = await db.query(`SELECT confirmed_at, submission_status FROM custom_domain_config WHERE id = $1`, [
        row.id,
      ])
      expect(saved.confirmed_at).not.toBeNull()
      expect(saved.submission_status).toBe('unknown')
      return cloud(row, mode)
    })
    expect(await domains.verify(org, draft.id)).toMatchObject({ submissionStatus: 'accepted', ready: false })
    expect(dns.verifyTls).not.toHaveBeenCalled()
    provider.reconcile.mockImplementation(cloud)
    await due(draft.id)
    expect(await domains.advance(org, draft.id)).toMatchObject({
      ready: true,
      certificateExpiresAt: new Date('2030-01-01T00:00:00Z'),
    })
    expect(dns.verifyTls).toHaveBeenCalledTimes(1)
  })

  it('distinguishes an explicit certificate rejection from an unknown submission', async () => {
    const draft = await domains.create(org, 'app.example.com')
    provider.reconcile.mockRejectedValueOnce(new DomainSetupError('provider_request_rejected', false, true))
    expect(await domains.verify(org, draft.id)).toMatchObject({
      submissionStatus: 'not_submitted',
      errorCode: 'provider_request_rejected',
      ready: false,
    })
  })

  it('preserves unknown submission outcomes and restores them through a fresh service instance', async () => {
    const draft = await domains.create(org, 'app.example.com')
    provider.reconcile.mockRejectedValueOnce(new DomainSetupError('provider_unavailable'))
    expect(await domains.verify(org, draft.id)).toMatchObject({
      submissionStatus: 'unknown',
      confirmed: true,
      ready: false,
    })
    const replica = new CustomDomainWorkflowService(
      db,
      config as never,
      subscription as never,
      dns as never,
      provider as never,
    )
    await due(draft.id)
    await replica.run(org, draft.id, 'advance')
    expect(await domains.get(org, draft.id)).toMatchObject({ submissionStatus: 'accepted' })
    expect(dns.checkAll).toHaveBeenCalledTimes(1)
  })

  it('does not report submission when the cloud result could not be saved', async () => {
    const draft = await domains.create(org, 'app.example.com')
    const spy = jest.spyOn(workflow as any, 'save').mockRejectedValueOnce(new Error('storage unavailable'))
    try {
      expect(await domains.verify(org, draft.id)).toMatchObject({ submissionStatus: 'unknown', ready: false })
    } finally {
      spy.mockRestore()
    }
    await due(draft.id)
    expect(await domains.advance(org, draft.id)).toMatchObject({ submissionStatus: 'accepted' })
  })

  it('supersedes the old owner and all pending applications only after the latest applicant verifies', async () => {
    const first = await ready()
    await db.query(`UPDATE domain SET box_id = 'old-box', port = 3000`)
    const next = await domains.create(other, first.hostname)
    expect((await domains.get(org, first.id)).ready).toBe(true)
    dns.checkAll.mockResolvedValueOnce([{ record: 'ownership', status: 'failed', errorCode: 'ownership_txt_mismatch' }])
    await domains.verify(other, next.id)
    expect((await domains.get(org, first.id)).ready).toBe(true)
    await domains.verify(other, next.id)
    expect(await domains.get(org, first.id)).toMatchObject({ phase: 'superseded', ready: false })
    expect(await db.query(`SELECT organization_id, box_id, port FROM domain`)).toEqual([
      { organization_id: other, box_id: null, port: null },
    ])
    await expect(domains.verify(org, first.id)).rejects.toMatchObject({ status: 409 })
    await expect(domains.advance(org, first.id)).rejects.toMatchObject({ status: 409 })
    const [old] = await db.query(`SELECT domain_id, superseded_by FROM custom_domain_config WHERE id = $1`, [first.id])
    expect(old).toEqual({ domain_id: null, superseded_by: next.id })
    await due(next.id)
    await domains.advance(other, next.id)
    expect(provider.reconcile.mock.calls.at(-1)![0].id).toBe(first.id)
  })

  it('does not clear a winning target on repeated verification or recheck ready DNS', async () => {
    const winner = await ready()
    await db.query(`UPDATE domain SET box_id = 'new-box', port = 8080`)
    dns.checkAll.mockClear()
    dns.verifyTls.mockClear()
    provider.reconcile.mockClear()
    await domains.verify(org, winner.id)
    await due(winner.id)
    await domains.advance(org, winner.id)
    expect(await db.query(`SELECT box_id, port FROM domain`)).toEqual([{ box_id: 'new-box', port: 8080 }])
    expect(dns.checkAll).not.toHaveBeenCalled()
    expect(dns.verifyTls).not.toHaveBeenCalled()
    expect(provider.reconcile).not.toHaveBeenCalled()
  })

  it('serializes concurrent confirmations across organizations and requires a new draft after losing', async () => {
    const a = await domains.create(org, 'app.example.com')
    const b = await domains.create(other, 'app.example.com')
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    dns.checkAll.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve([{ record: 'ownership', status: 'passed' }])
          entered()
        }),
    )
    const first = domains.verify(org, a.id)
    await started
    try {
      expect((await domains.verify(other, b.id)).confirmed).toBe(false)
      expect(dns.checkAll).toHaveBeenCalledTimes(1)
    } finally {
      release()
      await first
    }
    await expect(domains.verify(other, b.id)).rejects.toMatchObject({ status: 409 })
    expect(await db.query(`SELECT organization_id FROM domain`)).toEqual([{ organization_id: org }])
  })

  it.each(['expired', 'deleted'])('does not publish a late result after its lease is %s', async (reason) => {
    const draft = await domains.create(org, 'app.example.com')
    await domains.verify(org, draft.id)
    await due(draft.id)
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    dns.verifyTls.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve('2030-01-01T00:00:00Z')
          entered()
        }),
    )
    const pending = workflow.run(org, draft.id, 'advance')
    await started
    try {
      if (reason === 'expired') await db.query(`UPDATE custom_domain_config SET lease_until = '-infinity'`)
      else await domains.delete(org, draft.id)
    } finally {
      release()
      await pending
    }
    const [row] = await db.query(`SELECT phase FROM custom_domain_config WHERE id = $1`, [draft.id])
    expect(row.phase).not.toBe('ready')
  })

  it('fences a late TLS result after a newer organization verifies with a replacement lease', async () => {
    const first = await domains.create(org, 'app.example.com')
    await domains.verify(org, first.id)
    await due(first.id)
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    dns.verifyTls.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve('2030-01-01T00:00:00Z')
          entered()
        }),
    )
    const pending = workflow.run(org, first.id, 'advance')
    await started
    let next: Awaited<ReturnType<typeof domains.create>>
    try {
      next = await domains.create(other, first.hostname)
      expect(next.dnsRecords).toEqual([])
      await db.query(`UPDATE custom_domain_config SET lease_until = '-infinity' WHERE id = $1`, [first.id])
      await domains.prepare(other, next.id)
      await domains.verify(other, next.id)
    } finally {
      release()
      await pending
    }
    expect((await domains.get(org, first.id)).phase).toBe('superseded')
    expect(await db.query(`SELECT organization_id FROM domain`)).toEqual([{ organization_id: other }])
    expect((await domains.get(other, next!.id)).confirmed).toBe(true)
  })

  it('retains completed setup on an observation timeout, while cleanup requires no subscription or DNS', async () => {
    const winner = await ready()
    dns.verifyTls.mockRejectedValueOnce(new DomainSetupError('https_not_ready'))
    await workflow.run(org, winner.id, 'observe')
    expect((await domains.get(org, winner.id)).ready).toBe(true)
    subscription.refresh.mockRejectedValue(new Error('no subscription'))
    dns.checkAll.mockClear()
    await domains.delete(org, winner.id)
    expect(dns.checkAll).not.toHaveBeenCalled()
    const [row] = await db.query(`SELECT deleted_at, cleaned_at FROM custom_domain_config WHERE id = $1`, [winner.id])
    expect(row.deleted_at).not.toBeNull()
    expect(row.cleaned_at).not.toBeNull()
    expect(await db.query(`SELECT * FROM domain`)).toEqual([])
  })

  it('bounds quota and prevents cross-organization operations', async () => {
    const draft = await domains.create(org, 'app.example.com')
    await expect(domains.create(org, 'second.example.com')).rejects.toMatchObject({ status: 400 })
    await expect(domains.verify(other, draft.id)).rejects.toMatchObject({ status: 404 })
    await expect(domains.delete(other, draft.id)).rejects.toMatchObject({ status: 404 })
    subscription.refresh.mockResolvedValue({ status: 'required', expiresAt: Date.now() + 30_000 })
    expect(await domains.verify(org, draft.id)).toMatchObject({ errorCode: 'subscription_required', confirmed: false })
    expect(dns.checkAll).not.toHaveBeenCalled()
  })

  it('resumes a persisted submission on a replacement API without a page request', async () => {
    const draft = await domains.create(org, 'app.example.com')
    await domains.verify(org, draft.id)
    await due(draft.id)
    provider.reconcile.mockClear()
    dns.checkAll.mockClear()
    const replacement = new CustomDomainWorkflowService(
      db,
      config as never,
      subscription as never,
      dns as never,
      provider as never,
    )
    await replacement.advancePending()
    expect((await domains.get(org, draft.id)).ready).toBe(true)
    expect(provider.reconcile).toHaveBeenCalledTimes(1)
    expect(provider.reconcile.mock.calls[0][0].provider_state.certificateSubmitted).toBe(true)
    expect(dns.checkAll).not.toHaveBeenCalled()
  })

  it.each(['unconfirmed', 'ready', 'deleted', 'superseded', 'backoff', 'busy hostname'])(
    'does not auto-advance a %s configuration',
    async (reason) => {
      const draft = await domains.create(org, 'app.example.com')
      if (reason !== 'unconfirmed') await domains.verify(org, draft.id)
      await due(draft.id)
      if (reason === 'ready') await domains.advance(org, draft.id)
      if (reason === 'deleted') await domains.delete(org, draft.id)
      if (reason === 'ready' || reason === 'deleted') await due(draft.id)
      if (reason === 'superseded') await db.query(`UPDATE custom_domain_config SET superseded_by = $1`, [randomUUID()])
      if (reason === 'backoff')
        await db.query(`UPDATE custom_domain_config SET next_check_at = now() + interval '1 hour'`)
      if (reason === 'busy hostname') {
        const competing = await domains.create(other, draft.hostname)
        await db.query(
          `UPDATE custom_domain_config SET lease_owner = $2, lease_until = now() + interval '1 hour' WHERE id = $1`,
          [competing.id, randomUUID()],
        )
      }
      provider.reconcile.mockClear()
      dns.checkAll.mockClear()
      dns.verifyTls.mockClear()
      await workflow.advancePending()
      expect(provider.reconcile).not.toHaveBeenCalled()
      expect(dns.checkAll).not.toHaveBeenCalled()
      expect(dns.verifyTls).not.toHaveBeenCalled()
    },
  )

  it('limits each setup batch to three oldest due configurations without losing the remainder', async () => {
    const drafts: { id: string }[] = []
    for (let index = 0; index < 4; index++) {
      const owner = randomUUID()
      await db.query(`INSERT INTO organization (id) VALUES ($1)`, [owner])
      const draft = await domains.create(owner, `app${index}.example.com`)
      await domains.verify(owner, draft.id)
      await db.query(
        `UPDATE custom_domain_config SET next_check_at = now() - make_interval(secs => $2) WHERE id = $1`,
        [draft.id, 100 - index],
      )
      drafts.push(draft)
    }
    provider.reconcile.mockClear()
    await workflow.advancePending()
    expect(provider.reconcile.mock.calls.map(([row]) => row.id).sort()).toEqual(
      drafts
        .slice(0, 3)
        .map(({ id }) => id)
        .sort(),
    )
    await workflow.advancePending()
    expect(provider.reconcile).toHaveBeenCalledTimes(4)
    expect(
      (await db.query(`SELECT count(*)::int AS count FROM custom_domain_config WHERE phase = 'ready'`))[0].count,
    ).toBe(4)
  })

  it('shares execution leases between scheduled replicas and a simultaneous explicit request', async () => {
    const draft = await domains.create(org, 'app.example.com')
    await domains.verify(org, draft.id)
    await due(draft.id)
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    dns.verifyTls.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve('2030-01-01T00:00:00Z')
          entered()
        }),
    )
    provider.reconcile.mockClear()
    const pending = workflow.advancePending()
    await started
    try {
      const replica = new CustomDomainWorkflowService(
        db,
        config as never,
        subscription as never,
        dns as never,
        provider as never,
      )
      await Promise.all([replica.advancePending(), domains.advance(org, draft.id)])
      expect(provider.reconcile).toHaveBeenCalledTimes(1)
    } finally {
      release()
      await pending
    }
    expect((await domains.get(org, draft.id)).ready).toBe(true)
  })

  it('does not scan or expire drafts while the feature is disabled', async () => {
    const draft = await domains.create(org, 'app.example.com')
    await db.query(`UPDATE custom_domain_config SET last_action_at = now() - interval '31 days'`)
    settings.enabled = false
    const query = jest.spyOn(db, 'transaction')
    try {
      await Promise.all([workflow.advancePending(), workflow.maintain()])
      expect(query).not.toHaveBeenCalled()
      expect(
        (await db.query(`SELECT deleted_at FROM custom_domain_config WHERE id = $1`, [draft.id]))[0].deleted_at,
      ).toBeNull()
    } finally {
      query.mockRestore()
    }
  })

  it('expires abandoned drafts through maintenance without querying DNS', async () => {
    const draft = await domains.create(org, 'app.example.com')
    await db.query(`UPDATE custom_domain_config SET last_action_at = now() - interval '31 days'`)
    await workflow.maintain()
    expect(dns.checkAll).not.toHaveBeenCalled()
    const [row] = await db.query(`SELECT deleted_at, cleaned_at FROM custom_domain_config WHERE id = $1`, [draft.id])
    expect(row.deleted_at).not.toBeNull()
    expect(row.cleaned_at).not.toBeNull()
  })
})
