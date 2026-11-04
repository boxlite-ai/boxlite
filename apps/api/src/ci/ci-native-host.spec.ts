/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { testCapacity } from '../../../libs/ci-listener/tests/capacity'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { Logger } from '@nestjs/common'
import { WorkerPool } from '../../../libs/ci-listener/src/execution/pool'
import {
  ExecutionJournal,
  GitHubAppSource,
  VerifiedWebhook,
  ExecutionLease,
  ExecutionScope,
} from '@boxlite-ai/ci-listener'
import { CiNativeState } from './ci-native-state'
import { CiNativeHost } from './ci-native-host'
import { CiListenerService } from './ci-listener.service'
import { CiSettingsService } from './ci-settings.service'
import { AddCiListenerState1793700000000 } from '../migrations/pre-deploy/1793700000000-add-ci-listener-state-migration'
const database = process.env.CI_CONNECT_TEST_DATABASE_URL
const integration = database ? describe : describe.skip
integration('CI native host (Postgres binding and shared inbox)', () => {
  const schema = 'ci_native_host_' + randomUUID().replaceAll('-', ''),
    org = randomUUID(),
    binding = randomUUID(),
    actor = 'provider|owner'
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  let db: DataSource, store: CiNativeState, host: CiNativeHost, lease: ExecutionLease
  let upstream: jest.SpyInstance, requests: { path: string; method: string }[]
  let beforeRepositories: () => Promise<void>
  const config = { get: (key: string) => (key === 'ci.githubClientId' ? 'test-app' : undefined) }
  const notification = (): VerifiedWebhook => ({
    delivery: randomUUID(),
    event: 'workflow_job',
    digest: createHash('sha256').update('test-event').digest('hex'),
    hint: { installationId: 10, accountId: 20, repositoryId: 30, job: { id: 50, runId: 40 } },
  })
  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(database!).hostname))
      throw Error('Disposable local PostgreSQL required')
    db = await new DataSource({
      type: 'postgres',
      url: database,
      extra: { options: `-c search_path=${schema},public` },
    }).initialize()
    await db.query(`CREATE SCHEMA "${schema}";
      CREATE TABLE ci_installation_binding(id uuid PRIMARY KEY,generation bigint,github_host text,
      app_client_id text,installation_id bigint,account_id bigint,account_login text,account_type text,
      organization_id uuid,actor_id text,allow_public boolean,follow_installation boolean,state text);
      CREATE TABLE "user"(id text PRIMARY KEY,role text);
      CREATE TABLE organization_user("organizationId" uuid,"userId" text,role text)`)
    const query = db.createQueryRunner()
    try {
      await new AddCiListenerState1793700000000().up(query)
    } finally {
      await query.release()
    }
  })
  afterAll(async () => {
    if (db?.isInitialized)
      try {
        await db.query(`DROP SCHEMA "${schema}" CASCADE`)
      } finally {
        await db.destroy()
      }
  })
  // Poll the production directory protocol; no external work is awaited by a scheduler tick.
  async function discover(
    done: (view: { scopes: ExecutionScope[]; ready: boolean }) => boolean = (view) => view.ready,
  ): Promise<{ scopes: ExecutionScope[]; ready: boolean; pending: boolean }> {
    const signal = AbortSignal.timeout(5000)
    let refresh = true
    while (!signal.aborted) {
      const rows = await store.state.recover(lease, 1000, ['wake/'])
      const request = {
        refresh,
        wakes: rows.map((row) => ({
          key: row.key,
          version: row.version,
          ...(row.payload as { installationId: number; accountId: number; repositoryId: number }),
        })),
      }
      const view = await host.discover(lease, signal, request)
      refresh = false
      if (done(view)) return view
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    throw Error('Directory did not reach its observed completion condition')
  }
  beforeEach(async () => {
    await db.query('TRUNCATE ci_listener_state,ci_installation_binding,"user",organization_user')
    await db.query(
      `INSERT INTO ci_installation_binding VALUES($1,1,'github.com','test-app',10,20,'owner','User',$2,$3,true,true,'provisioning')`,
      [binding, org, actor],
    )
    await db.query('INSERT INTO "user" VALUES($1,\'user\');', [actor])
    await db.query("INSERT INTO organization_user VALUES($1,$2,'owner')", [org, actor])
    store = new CiNativeState(db, config as any)
    await store.initialize()
    lease = (await store.state.acquire(randomUUID(), 30000))!
    const app = new GitHubAppSource({ issuer: 'test-app', privateKey: () => privateKey })
    host = new CiNativeHost(db, store, {} as any, { appSource: () => app } as any, config as any)
    requests = []
    beforeRepositories = async () => {}
    upstream = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      const url = new URL(String(input)),
        method = options?.method || 'GET',
        path = url.pathname + url.search
      requests.push({ path, method })
      let value: unknown
      if (/^\/app\/installations\/\d+$/.test(url.pathname)) {
        const id = Number(url.pathname.split('/').at(-1))
        value = {
          id,
          account: { id: id + 10, login: id === 10 ? 'owner' : 'other', type: 'User' },
          suspended_at: null,
          permissions: { metadata: 'read', actions: 'read', administration: 'write' },
        }
      } else if (/^\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)) {
        const id = Number(url.pathname.split('/')[3])
        value = {
          token: 'catalog-' + id,
          expires_at: new Date(Date.now() + 3600000).toISOString(),
          permissions: { metadata: 'read' },
        }
      } else if (path === '/installation/repositories?per_page=100&page=1') {
        await beforeRepositories()
        const token = (options?.headers as Record<string, string>).Authorization
        const id = Number(token.split('-').at(-1)),
          owner = { id: id + 10, login: id === 10 ? 'owner' : 'other' }
        value = {
          total_count: 2,
          repositories: [
            { id: id + 20, name: 'repo', private: false, owner },
            { id: id + 30, name: 'private', private: true, owner },
          ],
        }
      } else if (path === '/installation/token' && method === 'DELETE') return new Response(null, { status: 204 })
      else throw Error('Unexpected upstream request ' + path)
      return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
  })
  afterEach(async () => {
    await host.close()
    upstream.mockRestore()
  })
  async function receipts() {
    return db.query(
      "SELECT record_key,payload FROM ci_listener_state WHERE record_key LIKE 'receipt/%' ORDER BY record_key",
    )
  }
  async function enableReplay() {
    await host.close()
    const enabled = {
      get: (key: string) => (key === 'ci.githubWebhookSecret' ? 'x'.repeat(32) : config.get(key)),
    }
    const app = new GitHubAppSource({ issuer: 'test-app', privateKey: () => privateKey })
    host = new CiNativeHost(db, store, {} as any, { appSource: () => app } as any, enabled as any)
    const reports = jest.spyOn(host, 'report').mockImplementation(() => {})
    const previous = upstream.getMockImplementation()!,
      guid = '00000000-0000-4000-8000-000000000001',
      at = new Date().toISOString()
    upstream.mockImplementation(async (input, options) => {
      const address = new URL(String(input)),
        method = options?.method ?? 'GET'
      if (address.pathname === '/app/hook/deliveries') {
        requests.push({ path: address.pathname + address.search, method })
        return new Response(
          JSON.stringify([
            {
              id: '1',
              guid,
              delivered_at: at,
              status_code: 503,
              event: 'workflow_job',
              action: 'queued',
              installation_id: 10,
              repository_id: 30,
            },
          ]),
        )
      }
      if (address.pathname.endsWith('/attempts')) {
        requests.push({ path: address.pathname, method })
        return new Response(null, { status: 202 })
      }
      return previous(input, options)
    })
    return { reports, key: 'replay/item/' + guid }
  }
  async function replayUntil(check: () => boolean | Promise<boolean>) {
    const signal = AbortSignal.timeout(4000)
    while (!signal.aborted) {
      host.recovery!.step(lease, signal)
      if (await check()) return
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    throw Error('Native replay did not reach boundary observation')
  }
  it('allows replay for an actually connected current owner in PostgreSQL', async () => {
    const { key } = await enableReplay()
    await replayUntil(() => requests.some((value) => value.method === 'POST'))
    expect(requests.filter((value) => value.method === 'POST')).toEqual([
      { path: '/app/hook/deliveries/1/attempts', method: 'POST' },
    ])
    const [row] = await store.state.read([key])
    expect(row.payload).toMatchObject({ attempts: 1, done: false })
    expect((row.payload as any).intent).toMatch(/^[a-f0-9-]{36}$/)
    expect(await receipts()).toEqual([])
  })
  it.each(['unconnected', 'owner', 'root', 'lease'])('denies actual native replay at the %s boundary', async (kind) => {
    const { reports, key } = await enableReplay()
    if (kind === 'unconnected') await db.query('DELETE FROM ci_installation_binding')
    if (kind === 'owner') await db.query('DELETE FROM organization_user')
    if (kind === 'root') {
      const [row] = await store.state.read(['backend/native'])
      await store.state.commit(lease, [{ key: row.key, expected: row.version, payload: { app: 'another-app' } }])
    }
    if (kind === 'lease')
      await db.query(
        "UPDATE ci_listener_state SET payload=jsonb_set(payload,'{until}','0'::jsonb) WHERE namespace=$1 AND record_key='@owner'",
        [store.namespace],
      )
    await replayUntil(async () => {
      if (kind === 'root' || kind === 'lease') return reports.mock.calls.length > 0
      const [row] = await store.state.read([key])
      return !!row && Number((row.payload as any).nextAt) > Date.now()
    })
    expect(requests.filter((value) => value.method === 'POST')).toEqual([])
    expect(await receipts()).toEqual([])
    if (kind === 'unconnected') expect(await db.query('SELECT id FROM ci_installation_binding')).toEqual([])
  })
  it('rechecks a PostgreSQL owner revoked after eligibility but before the replay intent', async () => {
    const { key } = await enableReplay(),
      admit = store.admit.bind(store)
    let admitted = 0
    const check = jest.spyOn(store, 'admit').mockImplementation(async (tx, scope) => {
      await admit(tx, scope)
      if (++admitted === 1) await tx.query('DELETE FROM organization_user')
    })
    try {
      await replayUntil(async () => {
        const [row] = await store.state.read([key])
        return !!row && Number((row.payload as any).nextAt) > Date.now()
      })
      expect(admitted).toBe(1)
      expect(requests.filter((value) => value.method === 'POST')).toEqual([])
      expect((await store.state.read([key]))[0].payload).toMatchObject({ attempts: 0, intent: null })
    } finally {
      check.mockRestore()
    }
  })
  it('does not install hosted replay without webhook configuration', () => {
    expect(host.recovery).toBeUndefined()
    expect(requests.some((value) => value.path.startsWith('/app/hook/deliveries'))).toBe(false)
  })
  it('starts two native API lifecycles without a state volume and acquires one PostgreSQL owner', async () => {
    await db.query('DELETE FROM ci_installation_binding')
    // Other host tests use a fixture-owned lease. This test must observe the
    // API runtimes themselves acquiring a fresh namespace, not that fixture.
    await db.query('TRUNCATE ci_listener_state')
    const values = {
      'ci.githubClientId': 'test-app',
      'ci.workerCPUs': 1,
      'ci.workerMemoryGB': 1,
      'ci.workerImage': 'runner:test',
    }
    const runtimeConfig = { get: (key: string) => values[key] }
    const github = { settings: () => ({ clientId: 'test-app' }) }
    const secondStore = new CiNativeState(db, runtimeConfig as any)
    const secondHost = new CiNativeHost(db, secondStore, {} as any, {} as any, runtimeConfig as any)
    const first = new CiListenerService(
      store,
      host,
      runtimeConfig as any,
      github as any,
      new CiSettingsService(store, {} as any),
    )
    const second = new CiListenerService(
      secondStore,
      secondHost,
      runtimeConfig as any,
      github as any,
      new CiSettingsService(secondStore, {} as any),
    )
    const acquired: (ExecutionLease | undefined)[] = []
    let complete!: () => void, timer: ReturnType<typeof setTimeout>
    const observed = new Promise<void>((resolve, reject) => {
      complete = resolve
      timer = setTimeout(() => reject(Error('Both API acquisition attempts must settle')), 3000)
    })
    const lookups = [store.state, secondStore.state].map((state) => {
      const acquire = state.acquire.bind(state)
      return jest.spyOn(state, 'acquire').mockImplementation(async (...args) => {
        const result = await acquire(...args)
        acquired.push(result)
        if (acquired.length >= 2) complete()
        return result
      })
    })
    try {
      await Promise.all([first.onModuleInit(), second.onModuleInit()])
      await observed
      expect(acquired.slice(0, 2).filter(Boolean)).toHaveLength(1)
      const owner = (
        await db.query("SELECT payload FROM ci_listener_state WHERE namespace=$1 AND record_key='@owner'", [
          store.namespace,
        ])
      )[0]?.payload
      expect(owner?.owner).toBeTruthy()
      expect(owner?.epoch).toBe(1)
      const event = notification()
      event.event = 'installation'
      event.hint.repositoryId = 0
      event.hint.job = null
      expect(await second.receive(event)).toBe('stored')
      expect(await receipts()).toHaveLength(1)
      expect(requests).toHaveLength(0)
    } finally {
      clearTimeout(timer!)
      await Promise.all([first.onModuleDestroy(), second.onModuleDestroy()])
      for (const lookup of lookups) lookup.mockRestore()
    }
  })
  it('keeps an unconfigured API disabled without creating a new state namespace', async () => {
    const disabledConfig = { get: () => undefined },
      disabledStore = new CiNativeState(db, disabledConfig as any)
    const disabledHost = new CiNativeHost(db, disabledStore, {} as any, {} as any, disabledConfig as any)
    const github = { settings: jest.fn() }
    const service = new CiListenerService(
      disabledStore,
      disabledHost,
      disabledConfig as any,
      github as any,
      new CiSettingsService(disabledStore, {} as any),
    )
    await service.onModuleInit()
    await expect(service.receive(notification())).rejects.toThrow('not configured')
    await service.onModuleDestroy()
    expect(github.settings).not.toHaveBeenCalled()
    expect(
      await db.query('SELECT record_key FROM ci_listener_state WHERE namespace=$1', [disabledStore.namespace]),
    ).toHaveLength(0)
  })
  it('stores and deduplicates an authorized webhook without the scheduler lease', async () => {
    const event = notification()
    expect(await host.accept(event)).toBe('stored')
    expect(await host.accept(event)).toBe('duplicate')
    expect(await receipts()).toHaveLength(1)
    const notices = await store.state.read(['notice/10/50'])
    expect(notices[0].payload).toMatchObject({
      installationId: 10,
      accountId: 20,
      repositoryId: 30,
      job: { id: 50, runId: 40 },
    })
  })
  it('rejects a conflicting event body without replacing the original receipt', async () => {
    const event = notification()
    await host.accept(event)
    await expect(host.accept({ ...event, digest: 'a'.repeat(64) })).rejects.toThrow('conflicts')
    expect((await receipts())[0].payload.digest).toBe(event.digest)
  })
  it.each([
    ['app', "UPDATE ci_installation_binding SET app_client_id='another'"],
    ['account', 'UPDATE ci_installation_binding SET account_id=21'],
    ['disabled', "UPDATE ci_installation_binding SET state='disabled'"],
    ['follow', 'UPDATE ci_installation_binding SET follow_installation=false'],
    ['actor', 'DELETE FROM "user"'],
    ['owner', 'DELETE FROM organization_user'],
  ])('rejects %s loss before writing any receipt or notice', async (_kind, sql) => {
    await db.query(sql)
    await expect(host.accept(notification())).rejects.toThrow()
    expect(await receipts()).toHaveLength(0)
    expect(await store.state.read(['notice/10/50'])).toHaveLength(0)
  })
  it('rechecks binding loss between the inbox read and write transactions', async () => {
    const transaction = db.transaction.bind(db)
    let calls = 0
    const wrapped = jest.spyOn(db, 'transaction').mockImplementation((async (...args: any[]) => {
      const result = await (transaction as any)(...args)
      if (++calls === 1) await db.query("UPDATE ci_installation_binding SET state='disabled'")
      return result
    }) as any)
    try {
      await expect(host.accept(notification())).rejects.toThrow('binding')
    } finally {
      wrapped.mockRestore()
    }
    expect(await receipts()).toHaveLength(0)
    expect(await store.state.read(['notice/10/50'])).toHaveLength(0)
  })
  it('retains signed installation-removal hints as discovery work without execution authority', async () => {
    await db.query('DELETE FROM ci_installation_binding')
    const event = notification()
    event.event = 'installation'
    event.hint.repositoryId = 0
    event.hint.job = null
    expect(await host.accept(event)).toBe('stored')
    expect(await store.state.read(['wake/10/0'])).toHaveLength(1)
    expect((await new ExecutionJournal(store.state).load(lease)).scopes.size).toBe(0)
  })
  it('discovers two personal repositories under the original connected BoxLite identity', async () => {
    const { scopes } = await discover()
    expect(scopes).toHaveLength(2)
    expect(scopes.map((s) => ({ binding: s.binding, actor: s.actor, organization: s.organization }))).toEqual(
      Array(2).fill({ binding, actor, organization: org }),
    )
    expect(scopes.map((s) => (s.runners.kind === 'repository' ? s.runners.repository.id : 0))).toEqual([30, 40])
    expect((await new ExecutionJournal(store.state).load(lease)).scopes.size).toBe(2)
    expect((await db.query('SELECT state FROM ci_installation_binding'))[0].state).toBe('ready')
    expect(requests.filter((r) => r.path === '/installation/token' && r.method === 'DELETE')).toHaveLength(1)
  })
  it('keeps two installations mapped to their own connected platform organizations', async () => {
    const otherOrg = randomUUID(),
      otherBinding = randomUUID()
    await db.query(
      `INSERT INTO ci_installation_binding VALUES($1,1,'github.com','test-app',11,21,'other','User',$2,$3,true,true,'provisioning')`,
      [otherBinding, otherOrg, actor],
    )
    await db.query("INSERT INTO organization_user VALUES($1,$2,'owner')", [otherOrg, actor])
    const { scopes } = await discover()
    expect(scopes).toHaveLength(4)
    expect(
      scopes.filter((s) => s.installation.id === 10).every((s) => s.organization === org && s.binding === binding),
    ).toBe(true)
    expect(
      scopes
        .filter((s) => s.installation.id === 11)
        .every((s) => s.organization === otherOrg && s.binding === otherBinding),
    ).toBe(true)
    expect((await new ExecutionJournal(store.state).load(lease)).scopes.size).toBe(4)
  })
  it('does not publish readiness if binding authority is revoked during GitHub inventory', async () => {
    beforeRepositories = async () => {
      await db.query("UPDATE ci_installation_binding SET state='disabled'")
    }
    const reported = jest.spyOn(host, 'report').mockImplementation(() => {})
    const result = await discover(() => reported.mock.calls.length > 0)
    expect(result.scopes).toEqual([])
    expect((await db.query('SELECT state FROM ci_installation_binding'))[0].state).toBe('disabled')
    expect(requests.filter((r) => r.path === '/installation/token' && r.method === 'DELETE')).toHaveLength(1)
  })
  it('keeps a healthy installation discoverable when another connected owner is revoked', async () => {
    const healthyOrg = randomUUID(),
      healthyBinding = randomUUID()
    await db.query(
      `INSERT INTO ci_installation_binding VALUES($1,1,'github.com','test-app',11,21,'other','User',$2,$3,true,true,'provisioning')`,
      [healthyBinding, healthyOrg, actor],
    )
    await db.query("INSERT INTO organization_user VALUES($1,$2,'owner')", [healthyOrg, actor])
    await db.query('DELETE FROM organization_user WHERE "organizationId"=$1', [org])
    const reported = jest.spyOn(host, 'report').mockImplementation(() => {})
    let discovered: ExecutionScope[] = []
    try {
      discovered = (
        await discover(
          (view) => reported.mock.calls.length > 0 && view.scopes.some((scope) => scope.installation.id === 11),
        )
      ).scopes
    } catch {
      // A directory error must withhold only the affected installation.
    }
    expect(discovered.some((scope) => scope.installation.id === 11 && scope.organization === healthyOrg)).toBe(true)
    expect(discovered.some((scope) => scope.installation.id === 10)).toBe(false)
    expect(requests.some((request) => request.path.startsWith('/app/installations/10'))).toBe(false)
  })
  it('admits no catalog requests for a connected actor who is no longer an owner', async () => {
    await db.query('DELETE FROM organization_user')
    const reported = jest.spyOn(host, 'report').mockImplementation(() => {})
    const result = await discover(() => reported.mock.calls.length > 0)
    expect(result.scopes).toEqual([])
    expect(requests).toHaveLength(0)
  })
  it.each([0, 137])('writes a real pool exit %s to the API logger with original CI identity', async (exit_code) => {
    const scope = (await discover()).scopes.find(
      (scope) => scope.runners.kind === 'repository' && scope.runners.repository.id === 30,
    )!
    const journal = new ExecutionJournal(store.state),
      key = await journal.define(lease, scope)
    let row = (await journal.reserve(
      lease,
      key,
      { repository: 30, run: 40, job: 50 },
      testCapacity({ account: 1, tenant: 1 }),
    ))!
    row = await journal.advance(lease, row.record.key, row.record.version, {
      box: { phase: 'requested', id: null },
      effect: { id: randomUUID(), kind: 'box-create' },
    })
    row = await journal.advance(lease, row.record.key, row.record.version, {
      box: { phase: 'known', id: 'original-log-box' },
    })
    const unexpected = async (): Promise<never> => {
      throw new Error('unexpected effect')
    }
    const backend = {
      admit: unexpected,
      job: unexpected,
      runners: unexpected,
      workers: {
        create: unexpected,
        get: async () => ({ box_id: 'original-log-box', status: 'stopped', exit_code }),
        stop: unexpected,
        remove: async () => {},
        deliverJit: unexpected,
      },
    }
    const info = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {}),
      warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    try {
      const pool = new WorkerPool(
        journal,
        key,
        async () => backend,
        { image: 'runner', cpus: 1, memoryMiB: 512, labels: ['boxlite-ci-runner'] },
        (event) => (host as any).observe(event),
      )
      await pool.tick(lease, testCapacity({ account: 1, tenant: 1 }))
      expect((exit_code === 0 ? info : warn).mock.calls).toContainEqual([
        expect.objectContaining({
          event: 'ci-worker-exited',
          level: exit_code === 0 ? 'info' : 'warn',
          exitCode: exit_code,
          organization: org,
          binding,
          boxId: 'original-log-box',
          trigger: { repository: 30, run: 40, job: 50 },
        }),
      ])
      expect(JSON.stringify([...info.mock.calls, ...warn.mock.calls])).not.toMatch(/catalog-|private-test|c2VjcmV0/)
    } finally {
      info.mockRestore()
      warn.mockRestore()
    }
  })
})
