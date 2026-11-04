/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { testCapacity } from '../../libs/ci-listener/tests/capacity'
import { EnvironmentCapacity } from './capacity'
import { createHmac, generateKeyPairSync, randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Listener,
  ListenerState,
  ExecutionLease,
  ExecutionScope,
  ExecutionJournal,
  StateDatabase,
  verifyWebhook,
} from '@boxlite-ai/ci-listener'
import { SqliteStateDatabase } from '../../libs/ci-listener/src/state/sqlite'
import { BoxLiteWorkers } from './boxlite-workers'
import { loadConfig, privateFile } from './config'
import { createHttp } from './http'
import { SelfHost } from './self-host'
import { WorkerPool } from '../../libs/ci-listener/src/execution/pool'

describe('Standalone App binding and HTTP ingress', () => {
  const originalFetch = global.fetch,
    keys = generateKeyPairSync('rsa', { modulusLength: 2048 }),
    secret = Buffer.alloc(32, 7)
  let directory: string,
    db: SqliteStateDatabase,
    state: ListenerState,
    lease: ExecutionLease,
    host: SelfHost,
    listener: Listener,
    http: ReturnType<typeof createHttp> | undefined,
    base: string,
    repositories: object[],
    namespace: string,
    keyFile: string
  const signed = (repository = 21, installation = 1, account = 7) => {
    const raw = Buffer.from(
      JSON.stringify(
        {
          action: 'queued',
          installation: { id: installation },
          repository: { id: repository, owner: { id: account } },
          workflow_job: { id: 55, run_id: 33, status: 'queued', labels: ['boxlite-ci-runner'] },
        },
        null,
        2,
      ),
    )
    return {
      raw,
      delivery: randomUUID(),
      event: 'workflow_job',
      signature: 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex'),
    }
  }
  // Poll the production directory protocol; no external work is awaited by a scheduler tick.
  async function discover(
    done: (view: { scopes: ExecutionScope[]; ready: boolean }) => boolean = (view) => view.ready,
  ): Promise<{ scopes: ExecutionScope[]; ready: boolean; pending: boolean }> {
    const signal = AbortSignal.timeout(5000)
    let refresh = true
    while (!signal.aborted) {
      const rows = await state.recover(lease, 1000, ['wake/'])
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
    directory = mkdtempSync(join(tmpdir(), 'ci-self-host-'))
    keyFile = join(directory, 'private.pem')
    writeFileSync(keyFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    db = new SqliteStateDatabase(join(directory, 'state'))
    namespace = 'ci-listener'
    state = new ListenerState(db, namespace)
    repositories = [21, 22].map((id) => ({ id, name: 'repo' + id, owner: { id: 7, login: 'owner' }, private: true }))
    const installation = {
      id: 1,
      account: { id: 7, login: 'owner', type: 'User' },
      suspended_at: null,
      permissions: { metadata: 'read', actions: 'read', administration: 'write' },
    }
    global.fetch = jest.fn(async (input, options) => {
      const url = new URL(String(input)),
        path = url.pathname
      if (url.hostname === '127.0.0.1') return originalFetch(input, options)
      const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
      if (url.origin === 'https://box.test' && path === '/v1/me')
        return json({ sub: 'owner-a', principal_type: 'service_account', path_prefix: 'tenant-a' })
      if (path === '/app/installations') return json([installation])
      if (path === '/app/installations/1') return json(installation)
      if (path === '/app/installations/1/access_tokens') {
        const body = JSON.parse(String(options?.body))
        return json(
          {
            token: 'private-fixture-installation-token',
            expires_at: new Date(Date.now() + 3600000).toISOString(),
            permissions: body.permissions,
          },
          201,
        )
      }
      if (path === '/installation/repositories') return json({ total_count: repositories.length, repositories })
      if (path === '/installation/token') return new Response(null, { status: 204 })
      throw new Error('Unexpected self-host fixture request')
    }) as typeof fetch
    const config = loadConfig({
      BOXLITE_REST_URL: 'https://box.test',
      BOXLITE_API_KEY: 'private-fixture-box-key',
      CI_GITHUB_APP_CLIENT_ID: 'test-client',
      CI_GITHUB_APP_PRIVATE_KEY_FILE: keyFile,
      CI_STATE_DIR: join(directory, 'state'),
    })
    const boxes = await BoxLiteWorkers.connect(state, config.endpoint, config.apiKey(), [
      { key: 'backend/github', payload: { kind: 'app', issuer: 'test-client' } },
    ])
    host = new SelfHost(config, state, db, namespace, boxes)
    lease = (await state.acquire('test-owner', 300000))!
    expect((await discover()).scopes).toHaveLength(2)
    listener = new Listener({ state, host, worker: config.worker, capacity: new EnvironmentCapacity(config.max) })
    http = undefined
  })
  afterEach(async () => {
    await http?.close()
    await host.close()
    global.fetch = originalFetch
    await db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const serve = async () => {
    http = createHttp(listener, host, secret)
    await new Promise<void>((resolve) => http!.server.listen(0, '127.0.0.1', resolve))
    const address = http.server.address()
    if (!address || typeof address === 'string') throw new Error('Missing server address')
    base = 'http://127.0.0.1:' + address.port
  }
  it.each([0, 137])('writes a real pool exit %s as JSON with original CI identity', async (exit_code) => {
    const scope = (await discover()).scopes[0],
      journal = new ExecutionJournal(state)
    const key = await journal.define(lease, scope)
    let row = (await journal.reserve(
      lease,
      key,
      { repository: 21, run: 33, job: 55 },
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
    const logging = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const pool = new WorkerPool(
        journal,
        key,
        async () => backend,
        { image: 'runner', cpus: 1, memoryMiB: 512, labels: ['boxlite-ci-runner'] },
        (event) => (host as any).observe(event),
      )
      await pool.tick(lease, testCapacity({ account: 1, tenant: 1 }))
      const events = logging.mock.calls.map(([line]) => JSON.parse(String(line)))
      expect(events).toContainEqual(
        expect.objectContaining({
          event: 'ci-worker-exited',
          level: exit_code === 0 ? 'info' : 'warn',
          exitCode: exit_code,
          boxId: 'original-log-box',
          trigger: { repository: 21, run: 33, job: 55 },
        }),
      )
      expect(JSON.stringify(events)).not.toMatch(/private-fixture|private-box|c2VjcmV0/)
    } finally {
      logging.mockRestore()
    }
  })
  const post = (input: ReturnType<typeof signed>) =>
    fetch(base + '/v1/ci/github/webhook', {
      method: 'POST',
      body: new Uint8Array(input.raw),
      headers: {
        'x-github-event': input.event,
        'x-github-delivery': input.delivery,
        'x-hub-signature-256': input.signature,
      },
    })
  const receipts = () => state.recover(lease, 1000, ['receipt/', 'notice/'])
  async function enableReplay() {
    await host.close()
    const config = loadConfig({
      BOXLITE_REST_URL: 'https://box.test',
      BOXLITE_API_KEY: 'private-fixture-box-key',
      CI_GITHUB_APP_CLIENT_ID: 'test-client',
      CI_GITHUB_APP_PRIVATE_KEY_FILE: keyFile,
      CI_GITHUB_WEBHOOK_SECRET_FILE: join(directory, 'webhook-secret'),
      CI_STATE_DIR: join(directory, 'state'),
    })
    const boxes = await BoxLiteWorkers.connect(state, config.endpoint, config.apiKey(), [
      { key: 'backend/github', payload: { kind: 'app', issuer: 'test-client' } },
    ])
    host = new SelfHost(config, state, db, namespace, boxes)
    jest.spyOn(host, 'report').mockImplementation(() => {})
    const previous = global.fetch,
      at = new Date().toISOString()
    const rows = [1, 2].map((id) => ({
      id: String(id),
      guid: `00000000-0000-4000-8000-00000000000${id}`,
      delivered_at: at,
      status_code: 503,
      event: 'workflow_job',
      action: 'queued',
      installation_id: id,
      repository_id: id + 20,
    }))
    const posts: string[] = []
    let suspendedAfter = Infinity,
      lookups = 0
    global.fetch = jest.fn(async (input, options) => {
      const address = new URL(String(input))
      if (address.pathname === '/app/hook/deliveries') return new Response(JSON.stringify(rows))
      if (address.pathname === '/app/installations/1' || address.pathname === '/app/installations/2') {
        const id = Number(address.pathname.split('/').at(-1))
        lookups++
        return new Response(
          JSON.stringify({
            id,
            account: { id: id + 6, login: id === 1 ? 'owner' : 'other', type: 'User' },
            permissions: { metadata: 'read', actions: 'read', administration: 'write' },
            suspended_at: lookups > suspendedAfter ? at : null,
          }),
        )
      }
      if (address.pathname.endsWith('/attempts')) {
        posts.push(address.pathname)
        return new Response(null, { status: 202 })
      }
      return previous(input, options)
    }) as typeof fetch
    return {
      posts,
      lookups: () => lookups,
      suspendAfter: (count: number) => {
        suspendedAfter = count
      },
    }
  }
  async function replayUntil(check: () => boolean | Promise<boolean>) {
    const signal = AbortSignal.timeout(3000)
    while (!signal.aborted) {
      host.recovery!.step(lease, signal)
      if (await check()) return
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    throw Error('Self-deployed replay did not reach boundary observation')
  }
  it('replays two App installations through the shared controller and real installation authority checks', async () => {
    const observed = await enableReplay()
    await replayUntil(() => observed.posts.length === 2)
    expect(observed.posts).toEqual(['/app/hook/deliveries/1/attempts', '/app/hook/deliveries/2/attempts'])
    expect(observed.lookups()).toBe(4)
    expect(await state.recover(lease, 100, ['notice/'])).toEqual([])
  })
  it('does not replay when an installation becomes suspended before mutation', async () => {
    const observed = await enableReplay()
    observed.suspendAfter(1)
    await replayUntil(async () => {
      const [row] = await state.read(['replay/item/00000000-0000-4000-8000-000000000001'])
      return !!row && Number((row.payload as any).nextAt) > Date.now()
    })
    expect(observed.posts).toEqual([])
    expect(observed.lookups()).toBe(2)
  })
  it.each(['root', 'lease'])('denies self-deployed replay at the %s boundary', async (kind) => {
    const observed = await enableReplay()
    if (kind === 'root') {
      const [row] = await state.read(['backend/github'])
      await state.commit(lease, [
        { key: row.key, expected: row.version, payload: { kind: 'app', issuer: 'another-app' } },
      ])
    } else
      await db.transaction(namespace, async (tx) => {
        const row = (await tx.get('@owner', true))!
        await tx.put({ ...row, version: randomUUID(), payload: { ...(row.payload as object), until: 0 } }, row.version)
      })
    await replayUntil(() => jest.mocked(host.report).mock.calls.length > 0)
    expect(observed.posts).toEqual([])
    expect(
      jest
        .mocked(global.fetch)
        .mock.calls.some(([address]) => new URL(String(address)).pathname === '/app/hook/deliveries'),
    ).toBe(false)
  })
  it('does not install replay when the webhook receiver is not configured', () => {
    expect(host.recovery).toBeUndefined()
    expect(
      jest
        .mocked(global.fetch)
        .mock.calls.some(([address]) => new URL(String(address)).pathname === '/app/hook/deliveries'),
    ).toBe(false)
  })
  it('publishes two personal repositories from the App catalog and stores a valid HTTP job once', async () => {
    await serve()
    const input = signed()
    expect((await post(input)).status).toBe(202)
    expect((await post(input)).status).toBe(202)
    const rows = await receipts()
    expect(rows.filter((row) => row.key.startsWith('receipt/'))).toHaveLength(1)
    expect(rows.filter((row) => row.key.startsWith('notice/'))).toHaveLength(1)
    expect(rows.find((row) => row.key === 'notice/1/55')?.payload).toMatchObject({ repositoryId: 21, accountId: 7 })
    expect(JSON.stringify(rows)).not.toContain('private-fixture')
  })
  it('stores a repository hint without granting execution outside the verified scope', async () => {
    await expect(listener.receive(verifyWebhook(signed(99), secret)!)).resolves.toBe('stored')
    const view = await discover(),
      backend = await host.backend(view.scopes[0], lease)
    try {
      await expect(backend.job({ repository: 99, run: 33, job: 55 })).rejects.toThrow(
        'outside the original execution scope',
      )
    } finally {
      await backend.close()
    }
    expect(await state.recover(lease, 1000, ['worker/'])).toEqual([])
  })
  it('persists a new repository job hint before an installation repository event or catalog refresh', async () => {
    await serve()
    const input = signed(99)
    expect((await post(input)).status).toBe(202)
    const rows = await receipts()
    expect(rows.filter((row) => row.key.startsWith('receipt/'))).toHaveLength(1)
    expect(rows.find((row) => row.key === 'notice/1/55')?.payload).toMatchObject({
      repositoryId: 99,
      accountId: 7,
    })
    expect((await state.recover(lease, 1000, ['worker/'])).length).toBe(0)
  })
  it('checks binding again in the write transaction after an authorized read', async () => {
    // The installation/account index, rather than a cached repository list, authorizes hints.
    const database: StateDatabase = db,
      transaction = database.transaction.bind(database)
    let revoke = true
    jest.spyOn(database, 'transaction').mockImplementation(async (namespace, work, mode) => {
      const result = await transaction(namespace, work, mode)
      if (mode === 'snapshot' && revoke) {
        revoke = false
        const upstream = global.fetch
        global.fetch = jest.fn(async (input, options) =>
          new URL(String(input)).pathname === '/app/installations' ? new Response('[]') : upstream(input, options),
        ) as typeof fetch
        await discover()
      }
      return result
    })
    await expect(listener.receive(verifyWebhook(signed(), secret)!)).rejects.toThrow('pending')
    expect(await receipts()).toEqual([])
  })
  it('requests inventory without accepting a job for an unknown installation', async () => {
    await serve()
    expect((await post(signed(31, 2, 8))).status).toBe(503)
    expect(await receipts()).toEqual([])
    expect((await state.read(['wake/2/0']))[0]?.payload).toEqual({
      installationId: 2,
      accountId: 8,
      repositoryId: 0,
    })
  })
  it('rejects a signed hint with the wrong account without enqueueing inventory', async () => {
    await serve()
    expect((await post(signed(21, 1, 8))).status).toBe(503)
    expect(await receipts()).toEqual([])
    expect(await state.read(['wake/1/0'])).toEqual([])
  })
  it.each(['signature', 'bytes', 'event'])('rejects or ignores an unauthenticated interpretation: %s', async (kind) => {
    await serve()
    const input = signed()
    if (kind === 'signature') input.signature = 'sha256=' + '0'.repeat(64)
    if (kind === 'bytes') input.raw = Buffer.from('{}')
    if (kind === 'event') input.event = 'installation'
    const response = await post(input)
    expect(response.status).toBe(kind === 'event' ? 202 : 401)
    expect(await receipts()).toEqual([])
  })
  it('limits a real HTTP body before storing a receipt', async () => {
    await serve()
    const input = signed()
    input.raw = Buffer.alloc(1048577)
    const response = await post(input)
    expect(response.status).toBe(413)
    await response.body?.cancel()
    expect(await receipts()).toEqual([])
  })
  it('exposes health without disclosing credentials or claiming a CI result', async () => {
    await serve()
    const result = await (await fetch(base + '/healthz')).json()
    expect(result).toEqual({ process: 'running', discovery: 'ready' })
    expect((await fetch(base + '/not-a-webhook')).status).toBe(404)
  })
  it('does not use a malformed current account index', async () => {
    const [current] = await state.read(['binding/self/current'])
    await state.commit(lease, [{ key: current.key, expected: current.version, payload: { accounts: [] } }])
    await expect(listener.receive(verifyWebhook(signed(), secret)!)).rejects.toThrow('pending')
    expect(await receipts()).toEqual([])
  })
  it('reads private files but rejects group/world-readable files and symlinks', () => {
    expect(privateFile(keyFile).length).toBeGreaterThan(100)
    chmodSync(keyFile, 0o644)
    expect(() => privateFile(keyFile)).toThrow('private permissions')
    chmodSync(keyFile, 0o600)
    const link = join(directory, 'link.pem')
    symlinkSync(keyFile, link)
    expect(() => privateFile(link)).toThrow('private permissions')
  })
})

describe('Standalone ENV configuration', () => {
  const base = {
    BOXLITE_REST_URL: 'https://box.test',
    BOXLITE_API_KEY: 'private-api-key',
    CI_GITHUB_APP_CLIENT_ID: 'test-client',
    CI_GITHUB_APP_PRIVATE_KEY_FILE: '/private/key.pem',
  }
  it('needs only App and BoxLite credentials, with conservative resource defaults', () => {
    const config = loadConfig(base)
    expect(config.max).toBe(1)
    expect(config.worker).toMatchObject({ cpus: 2, memoryMiB: 2048 })
    expect(config.listen).toEqual({ host: '0.0.0.0', port: 8080 })
    expect(config.allowPublic).toBe(false)
    expect(JSON.stringify(config)).not.toContain('private-api-key')
  })
  it('supports the independent single-repository token path', () => {
    const config = loadConfig({
      BOXLITE_REST_URL: base.BOXLITE_REST_URL,
      BOXLITE_API_KEY: base.BOXLITE_API_KEY,
      GITHUB_TOKEN: 'private-personal-token',
      GITHUB_CONFIG_URL: 'https://github.com/owner/repo',
    })
    expect(config.github.kind).toBe('pat')
    expect(JSON.stringify(config)).not.toContain('private-personal-token')
  })
  it('does not choose ambiguously between PAT and App identities', () => {
    expect(() => loadConfig({ ...base, GITHUB_TOKEN: 'private-token' })).toThrow('Choose App credentials')
  })
  it.each(['0', 'NaN', 'Infinity', '0.124', '1.0001', '129'])('rejects invalid memory: %s', (memory) => {
    expect(() => loadConfig({ ...base, CI_WORKER_MEMORY_GB: memory })).toThrow('whole MiB')
  })
  it('converts GB exactly using 1024 MiB per GB', () => {
    expect(loadConfig({ ...base, CI_WORKER_MEMORY_GB: '0.5' }).worker.memoryMiB).toBe(512)
  })
  it.each([
    'https://example.com/owner/repo',
    'https://github.com/owner/repo?token=bad',
    'https://github.com/owner/repo/actions',
  ])('rejects an invalid token repository endpoint', (url) => {
    expect(() =>
      loadConfig({
        BOXLITE_REST_URL: base.BOXLITE_REST_URL,
        BOXLITE_API_KEY: base.BOXLITE_API_KEY,
        GITHUB_TOKEN: 'private-token',
        GITHUB_CONFIG_URL: url,
      }),
    ).toThrow()
  })
})
