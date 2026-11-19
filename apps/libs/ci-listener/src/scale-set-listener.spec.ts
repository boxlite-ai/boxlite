/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { DataSource } from 'typeorm'
import { PostgresStateDatabase, postgresStateTable } from './state/postgres'
import { CredentialSource } from './credentials'
import { GitHubAppSource, GitHubInstallation } from './github-app'
import { createHmac, generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { GitHubExecutionBackend } from './execution/backend'
import { ExecutionJournal } from './execution/journal'
import { decodeScope, ExecutionScope } from './execution/model'
import { Listener, ListenerHost } from './listener'
import { scaleSetBindings, ScaleSetController, ScaleSetWork } from './scale-set-controller'
import { ActionsScaleSets } from './scale-set-client'
import { SqliteStateDatabase } from './state/sqlite'
import { ListenerState } from './state/store'
import { ListenerInbox, verifyWebhook } from './webhook'
import { ConfirmedWorkerAbsent, WorkerExecutor, WorkerState } from './worker'

/** Public wire shapes. No external runner or installation is needed by this fixture. */
class ActionsFixture {
  readonly repository = { id: 21, name: 'repo', owner: { id: 7, login: 'owner' }, private: true }
  constructor(private readonly prefix = '') {}
  get queue() {
    return 'https://' + this.prefix + 'broker.actions.githubusercontent.com/messages'
  }
  get service() {
    return 'https://' + this.prefix + 'pipelines.actions.githubusercontent.com/tenant'
  }
  readonly sessions: string[] = []
  readonly runners = new Map<string, { id: number; name: string; runnerScaleSetId: number }>()
  readonly acknowledged: number[] = []
  readonly requests: string[] = []
  readonly acquired: number[][] = []
  discoverCustom = false
  defaultSet?: { id: number; name: string; labels: unknown[]; runnerGroupId: number }
  labels = ['boxlite']
  interruptAcquisition?: () => void
  target = 0
  definition?: { id: number; name: string; labels: unknown[]; runnerGroupId: number }
  installation?: GitHubInstallation
  private messages: object[] = []
  private waiter?: () => void
  publish(id: number, assigned: number, offers: number[] = [], extra: object[] = []) {
    this.target = assigned
    this.messages.push({
      messageId: id,
      messageType: 'RunnerScaleSetJobMessages',
      statistics: { totalAssignedJobs: assigned },
      body: JSON.stringify([
        ...extra,
        ...offers.map((runnerRequestId) => ({
          messageType: 'JobAvailable',
          runnerRequestId,
          ownerName: 'owner',
          repositoryName: 'repo',
          requestLabels: this.labels,
        })),
      ]),
    })
    this.waiter?.()
  }
  async fetch(url: string | URL | Request, options: RequestInit = {}) {
    const addr = new URL(String(url)),
      path = addr.pathname,
      method = options.method ?? 'GET'
    this.requests.push(method + ' ' + path)
    if (path === '/app/installations/1' && this.installation)
      return Response.json({ ...this.installation, suspended_at: null })
    if (path === '/app/installations/1/access_tokens') {
      const body = JSON.parse(String(options.body))
      return Response.json(
        {
          token: 'local-token',
          expires_at: new Date(Date.now() + 3600000).toISOString(),
          permissions: { ...body.permissions, metadata: 'read' },
          ...(body.repository_ids ? { repositories: body.repository_ids.map((id: number) => ({ id })) } : {}),
        },
        { status: 201 },
      )
    }
    if (path === '/installation/token') return new Response(null, { status: 204 })
    if (path === '/orgs/owner') return Response.json(this.repository.owner)
    if (path === '/orgs/owner/actions/runner-groups/5')
      return Response.json({
        id: 5,
        visibility: 'selected',
        inherited: false,
        restricted_to_workflows: false,
        allows_public_repositories: false,
      })
    if (path === '/orgs/owner/actions/runner-groups/5/repositories')
      return Response.json({ total_count: 1, repositories: [this.repository] })
    if (method === 'GET' && /\/actions\/runners\/\d+$/.test(path)) {
      const runner = [...this.runners.values()].find((runner) => path.endsWith('/' + runner.id))
      return runner ? Response.json({ ...runner, status: 'online', busy: true }) : new Response(null, { status: 404 })
    }
    if (path === '/repositories/21') return Response.json(this.repository)
    if (path.endsWith('/registration-token')) return Response.json({ token: 'registration' })
    if (path === '/actions/runner-registration')
      return Response.json({
        url: this.service,
        token:
          'a.' +
          Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') +
          '.c',
      })
    const data = options.body ? JSON.parse(String(options.body)) : undefined
    if (path.endsWith('/runnerscalesets')) {
      if (method === 'POST') {
        if (this.discoverCustom && data.labels.some((label: { name: string }) => label.name === 'boxlite'))
          return Response.json((this.defaultSet = { ...data, id: 8 }))
        return Response.json((this.definition = { ...data, id: 9 }))
      }
      const sets = [this.definition, this.defaultSet].filter(
        (value) => value && value.name === addr.searchParams.get('name'),
      )
      return Response.json({ count: sets.length, value: sets })
    }
    if (path.endsWith('/runnerscalesets/8'))
      return this.defaultSet
        ? Response.json({ ...this.defaultSet, statistics: { totalAssignedJobs: 0 } })
        : new Response(null, { status: 404 })
    if (path.endsWith('/8/sessions') && method === 'POST')
      return Response.json({
        sessionId: randomUUID(),
        messageQueueUrl: this.queue + '/default',
        messageQueueAccessToken: 'idle',
        statistics: { totalAssignedJobs: 0 },
      })
    if (path.includes('/8/sessions/') && method === 'DELETE') return new Response(null, { status: 204 })
    if (path === '/messages/default') {
      const signal = options.signal!
      await new Promise<never>((_, reject) => {
        signal.throwIfAborted()
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
    if (path.endsWith('/runnerscalesets/9') && method === 'GET')
      return Response.json({ ...this.definition, statistics: { totalAssignedJobs: this.target } })
    if (path.endsWith('/9/sessions') && method === 'POST') {
      const sessionId = randomUUID()
      this.sessions.push(sessionId)
      return Response.json({
        sessionId,
        messageQueueUrl: this.queue,
        messageQueueAccessToken: 'session',
        statistics: { totalAssignedJobs: this.target },
      })
    }
    if (method === 'DELETE' && path.includes('/9/sessions/')) return new Response(null, { status: 204 })
    if (path === '/messages' && method === 'GET') {
      if (!this.messages.length)
        await new Promise<void>((resolve, reject) => {
          const signal = options.signal!
          const abort = () => {
            this.waiter = undefined
            reject(signal.reason)
          }
          signal.throwIfAborted()
          this.waiter = () => {
            this.waiter = undefined
            signal.removeEventListener('abort', abort)
            resolve()
          }
          signal.addEventListener('abort', abort, { once: true })
        })
      return Response.json(this.messages.shift())
    }
    if (path.startsWith('/messages/') && method === 'DELETE') {
      this.acknowledged.push(Number(path.split('/').at(-1)))
      return new Response(null, { status: 204 })
    }
    if (path.endsWith('/acquirejobs')) {
      this.acquired.push(data)
      if (this.interruptAcquisition) {
        this.target += data.length
        this.interruptAcquisition()
        this.interruptAcquisition = undefined
        throw Error('Lost acquisition reply')
      }
      return Response.json({ count: data.length, value: data })
    }
    if (path.endsWith('/generatejitconfig')) {
      const runner = { id: 100 + this.runners.size, name: data.name, runnerScaleSetId: 9 }
      this.runners.set(data.name, runner)
      return Response.json({ runner, encodedJITConfig: Buffer.from(data.name).toString('base64') })
    }
    if (path.endsWith('/agents')) {
      const runner = this.runners.get(addr.searchParams.get('agentName')!)
      return Response.json({ count: runner ? 1 : 0, value: runner ? [runner] : [] })
    }
    if (path.includes('/agents/') && method === 'DELETE') {
      for (const [name, runner] of this.runners) if (path.endsWith('/' + runner.id)) this.runners.delete(name)
      return new Response(null, { status: 204 })
    }
    throw new Error('Unexpected Actions request ' + method + ' ' + path)
  }
}

const scenarios = [
  'reconciles acquired and replayed demand',
  'backs off failed Box startup',
  'backs off a Box exit without a status code',
  'checks an organization runner group',
  'recovers an acknowledged JIT upload',
  'takes over after acquisition before the ledger commit',
  'reuses a held slot after cancellation between statistics samples',
  'returns an undispatched reservation for a deleted set',
  'rechecks shrinking quota after a long poll',
  'leaves the remaining quota for already assigned demand',
  'starts an organization worker with the custom resource label',
  'discovers a custom resource label from a standalone PAT repository scan',
] as const
for (const storage of ['sqlite', 'postgres'])
  (storage === 'postgres' && !process.env.DB_HOST ? describe.skip : describe)('scale set listener ' + storage, () => {
    it.each(scenarios)(
      '%s through the listener',
      async (scenario) => {
        const directory = mkdtempSync(join(tmpdir(), 'ci-scale-sets-'))
        const schema = 'ci_set_' + randomUUID().replaceAll('-', '')
        const db = storage === 'sqlite' ? new SqliteStateDatabase(directory) : undefined
        let pg: DataSource | undefined
        if (!db) {
          if (!['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST!))
            throw Error('Disposable local PostgreSQL required')
          pg = await new DataSource({
            type: 'postgres',
            host: process.env.DB_HOST,
            port: Number(process.env.DB_PORT || 5432),
            username: process.env.DB_USERNAME,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_DATABASE,
            extra: { options: '-c search_path=' + schema + ',public', application_name: schema },
          }).initialize()
          await pg.query('CREATE SCHEMA ' + schema)
          await pg.query(postgresStateTable)
        }
        const state = new ListenerState(db ?? new PostgresStateDatabase(pg!), 'test')
        const journal = new ExecutionJournal(state)
        const fixture = new ActionsFixture()
        const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(fixture.fetch.bind(fixture))
        const scope: ExecutionScope = {
          binding: 'personal-token',
          actor: 'actor',
          generation: 1,
          organization: 'tenant',
          installation: { id: 0, account: { ...fixture.repository.owner, type: 'User' } },
          runners: { kind: 'repository', repository: fixture.repository, allowPrivate: true, allowPublic: false },
        }
        let source: CredentialSource = { kind: 'pat', repository: 21, token: () => 'local-token' }
        if (
          scenario === 'checks an organization runner group' ||
          scenario === 'starts an organization worker with the custom resource label'
        ) {
          scope.binding = 'binding-org'
          scope.installation = { id: 1, account: { ...fixture.repository.owner, type: 'Organization' } }
          scope.runners = {
            kind: 'organization',
            account: fixture.repository.owner,
            group: 5,
            repositories: [21],
            allowPrivate: true,
            allowPublic: false,
          }
          fixture.installation = {
            ...scope.installation,
            permissions: { metadata: 'read', actions: 'read', organization_self_hosted_runners: 'write' },
            suspended: false,
          }
          const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
          source = {
            kind: 'app',
            app: new GitHubAppSource({ issuer: 'test', privateKey: () => keys.privateKey }),
            installation: fixture.installation,
          }
        }
        const scanOnly = scenario === 'discovers a custom resource label from a standalone PAT repository scan'
        if (scanOnly || scenario === 'starts an organization worker with the custom resource label') {
          fixture.labels = ['boxlite-1vcpu-1gbmem-10gbdisk']
          fixture.discoverCustom = true
        }
        const boxes = new Map<string, WorkerState>()
        const delivered = new Set<string>()
        const recoverJit = jest.fn(async (name: string) =>
          delivered.has(name) ? ('delivered' as const) : ('unknown' as const),
        )
        const workers: WorkerExecutor = {
          recoverJit,
          create: jest.fn(async (launch) => {
            const box = { box_id: randomUUID(), status: 'running', recoverableJit: true }
            boxes.set(launch.name, box)
            return box
          }),
          get: async (name) => {
            const box = boxes.get(name)
            if (!box) throw new ConfirmedWorkerAbsent()
            return box
          },
          stop: async (name) => {
            boxes.get(name)!.status = 'stopped'
          },
          remove: async (name) => {
            boxes.delete(name)
          },
          deliverJit: jest.fn(async (name, jit) => {
            expect(Buffer.from(jit, 'base64').toString()).toBe(name)
            delivered.add(name)
            if (scenario === 'recovers an acknowledged JIT upload') throw Error('Lost Box upload reply')
          }),
        }
        const errors: string[] = []
        const inbox = new ListenerInbox(state)
        const host: ListenerHost = {
          discover: async () => ({ scopes: [scope], completed: [], pending: false, ready: true }),
          backend: async (original, lease) =>
            new GitHubExecutionBackend(state, lease, original, source, { workers, authorize: async () => {} }, [
              'boxlite',
            ]),
          report: (error, operation) => errors.push(operation + ': ' + String(error)),
          scan: jest.fn(),
          accept: (event) => inbox.receive(event),
        }
        let listener: Listener
        let maximum = 2
        const start = () => {
          const controller = new AbortController()
          listener = new Listener({
            state,
            host,
            worker: { image: 'jitbox', cpus: 2, memoryMiB: 2048, labels: ['boxlite'] },
            capacity: { resolve: async () => ({ limits: [{ maximum, domain: 'organization' }] }) },
            scaleSets: scaleSetBindings(JSON.stringify({ [scope.binding]: ['boxlite'] })),
            timing: { tickMs: 5, leaseMs: 450 },
          })
          const task = listener.run(controller.signal)
          return async () => {
            controller.abort()
            await task
          }
        }
        const until = async (predicate: () => boolean | Promise<boolean>) => {
          const deadline = Date.now() + 4500
          while (!(await predicate())) {
            if (Date.now() > deadline)
              throw new Error(
                'Listener deadline: ' +
                  JSON.stringify({ errors: errors.slice(-4), requests: fixture.requests.slice(-8) }),
              )
            await delay(10)
          }
        }
        let stop: (() => Promise<void>) | undefined
        try {
          await journal.initialize()
          if (scenario === 'returns an undispatched reservation for a deleted set') {
            const owner = (await state.acquire(randomUUID(), 600))!
            const originalScope = await journal.define(owner, scope)
            await state.commit(owner, [
              {
                key: 'scale-set/' + originalScope.slice(6) + '/boxlite',
                expected: null,
                payload: { name: 'boxlite-' + 'a'.repeat(32), set: 8, assigned: 1, message: null, session: null },
              },
            ])
            const reservation = await journal.reserve(
              owner,
              originalScope,
              null,
              { limits: [{ domain: 'organization', maximum: 2 }] },
              { labels: ['boxlite'], scaleSet: 8 },
            )
            expect(reservation).toBeDefined()
            stop = start()
            await until(() => fixture.requests.includes('GET /tenant/_apis/runtime/runnerscalesets/8'))
            await until(async () => (await journal.used('tenant')) === 0)
            expect(workers.create).not.toHaveBeenCalled()
            await until(() => fixture.sessions.length === 1)
            expect(fixture.definition?.id).toBe(9)
            return
          }
          if (scanOnly) {
            const former = (await state.acquire(randomUUID(), 600))!,
              scans = state.scans()
            await scans.synchronize(former, 'personal-token', scope.binding, [scope])
            const claim = (await scans.claim('label-scanner'))!
            await scans.publish(
              claim,
              [{ repository: 21, job: 55, run: 33, status: 'queued', labels: fixture.labels, runner: null }],
              ['boxlite'],
            )
            await scans.finish(claim, { success: true, intervalMs: 60_000 })
          }
          stop = start()
          if (fixture.discoverCustom && !scanOnly) {
            await until(() => fixture.requests.includes('GET /messages/default'))
            expect(fixture.definition).toBeUndefined()
            const secret = Buffer.alloc(32, 1),
              raw = Buffer.from(
                JSON.stringify({
                  action: 'queued',
                  installation: { id: 1 },
                  repository: { id: 21, owner: { id: 7 } },
                  workflow_job: { id: 51, run_id: 31, status: 'queued', labels: fixture.labels },
                }),
              )
            const webhook = verifyWebhook(
              {
                raw,
                event: 'workflow_job',
                delivery: randomUUID(),
                signature: 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex'),
              },
              secret,
            )!
            expect(await listener!.receive(webhook)).toBe('stored')
          }
          await until(() => fixture.sessions.length > 0)
          if (pg) {
            await until(() => fixture.requests.includes('GET /messages'))
            const [{ cutoff }] = await pg.query('SELECT clock_timestamp() AS cutoff')
            // Ordinary listener ticks continue short transactions while the HTTP poll is outstanding.
            await delay(120)
            const connections = await pg.query(
              'SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE application_name=$1 AND xact_start <= $2::timestamptz',
              [schema, cutoff],
            )
            expect(connections[0].waiting).toBe(0)
          }
          if (
            scenario === 'rechecks shrinking quota after a long poll' ||
            scenario === 'leaves the remaining quota for already assigned demand'
          ) {
            await until(() => fixture.requests.includes('GET /messages'))
            maximum = scenario.startsWith('leaves') ? 1 : 0
            fixture.publish(0, maximum, [123])
            await until(() => fixture.acknowledged.includes(0))
            expect(fixture.acquired).toEqual([])
            if (maximum) await until(() => (workers.deliverJit as jest.Mock).mock.calls.length === 1)
            else expect(workers.create).not.toHaveBeenCalled()
            return
          }
          if (scenario === 'reuses a held slot after cancellation between statistics samples') {
            maximum = 1
            await until(() => fixture.requests.includes('GET /messages'))
            fixture.publish(0, 0, [123])
            await until(() => fixture.acknowledged.includes(0))
            expect(fixture.acquired).toEqual([[123]])
            fixture.publish(
              1,
              0,
              [],
              [
                { messageType: 'JobAssigned', runnerRequestId: 123 },
                { messageType: 'JobCompleted', runnerRequestId: 123, runnerId: 0, runnerName: '', result: 'canceled' },
              ],
            )
            await until(() => fixture.acknowledged.includes(1))
            for (const message of [2, 3, 4]) {
              fixture.publish(message, 0, [124])
              await until(() => fixture.acknowledged.includes(message))
              if (fixture.acquired.some((ids) => ids.includes(124))) break
            }
            expect(fixture.acquired).toEqual([[123], [124]])
            return
          }
          if (scenario === 'takes over after acquisition before the ledger commit') {
            let acquired!: () => void
            const completion = new Promise<void>((resolve) => {
              acquired = resolve
            })
            fixture.interruptAcquisition = acquired
            fixture.publish(0, 0, [123, 124, 125])
            await completion
            await stop()
            stop = start()
            await until(() => fixture.sessions.length === 2)
            fixture.publish(0, 0, [123, 124, 125])
            fixture.target = 2
            await until(() => fixture.acknowledged.includes(0))
            await until(() => (workers.deliverJit as jest.Mock).mock.calls.length === 2)
            expect(fixture.acquired).toEqual([[123, 124]])
            expect(await journal.used('tenant')).toBe(2)
            return
          }
          fixture.publish(
            0,
            0,
            [123, 124, 125],
            [
              {
                messageType: 'JobAvailable',
                runnerRequestId: 991,
                ownerName: 'owner',
                repositoryName: 'foreign',
                requestLabels: ['boxlite'],
              },
              {
                messageType: 'JobAvailable',
                runnerRequestId: 992,
                ownerName: 'other',
                repositoryName: 'repo',
                requestLabels: ['boxlite'],
              },
            ],
          )
          await until(() => fixture.acknowledged.includes(0))
          expect(fixture.acquired).toEqual([[123, 124]])
          fixture.publish(1, 2)
          await until(() => (workers.deliverJit as jest.Mock).mock.calls.length === 2)
          expect(await journal.used('tenant')).toBe(2)
          if (fixture.discoverCustom) {
            expect(fixture.definition?.runnerGroupId).toBe(scanOnly ? 1 : 5)
            expect(fixture.definition?.labels).toContainEqual({ name: fixture.labels[0], type: 'System' })
            for (const [launch] of (workers.create as jest.Mock).mock.calls)
              expect(launch).toMatchObject({ cpus: 1, memoryMiB: 1024, diskGiB: 10 })
          }
          if (scenario.startsWith('backs off')) {
            for (const box of boxes.values()) {
              if (scenario === 'backs off failed Box startup') {
                box.status = 'error'
                box.exit_code = 1
              } else box.status = 'stopped'
            }
            await until(() => (workers.create as jest.Mock).mock.calls.length > 2 || boxes.size === 0)
            await delay(300)
            expect(workers.create).toHaveBeenCalledTimes(2)
            fixture.publish(2, 0, [126])
            await until(() => fixture.acknowledged.includes(2))
            expect(fixture.acquired).toEqual([[123, 124]])
            fixture.publish(3, 1)
            await until(() => fixture.acknowledged.includes(3))
            await delay(200)
            expect(workers.create).toHaveBeenCalledTimes(2)
            await until(() => (workers.create as jest.Mock).mock.calls.length === 3)
            return
          }
          if (scenario === 'checks an organization runner group') {
            expect(fixture.definition?.runnerGroupId).toBe(5)
            expect(fixture.requests).toContain('POST /orgs/owner/actions/runners/registration-token')
            expect(fixture.requests).toContain('GET /orgs/owner/actions/runner-groups/5/repositories')
          }
          await stop()
          stop = start()
          await until(() => fixture.sessions.length === 2)
          fixture.publish(1, 2)
          await until(() => fixture.acknowledged.filter((id) => id === 1).length === 2)
          expect(workers.create).toHaveBeenCalledTimes(2)
          expect(workers.deliverJit).toHaveBeenCalledTimes(2)
          if (scenario === 'recovers an acknowledged JIT upload') {
            await until(() => recoverJit.mock.calls.length >= 2)
            expect(new Set(recoverJit.mock.calls.map(([name]) => name))).toEqual(delivered)
          }
          fixture.publish(2, 0)
          await until(() => fixture.acknowledged.includes(2))
          for (const box of boxes.values()) box.status = 'stopped'
          await until(
            async () => boxes.size === 0 && fixture.runners.size === 0 && (await journal.used('tenant')) === 0,
          )
          expect(fixture.requests.some((call) => /\/actions\/runners$/.test(call))).toBe(false)
        } finally {
          await stop?.()
          fetch.mockRestore()
          await db?.close()
          if (pg?.isInitialized) {
            try {
              await pg.query('DROP SCHEMA ' + schema + ' CASCADE')
            } finally {
              await pg.destroy()
            }
          }
          rmSync(directory, { recursive: true, force: true })
        }
      },
      20000,
    )
  })

it('reserves one shared global slot for concurrent offers to two tenants', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ci-set-global-'))
  const db = new SqliteStateDatabase(directory)
  const state = new ListenerState(db, 'concurrent'),
    journal = new ExecutionJournal(state)
  const fixtures = [new ActionsFixture('first-'), new ActionsFixture('second-')]
  const work = new ScaleSetWork(),
    lifetime = new AbortController(),
    controllers: ScaleSetController[] = []
  const requests = jest.spyOn(globalThis, 'fetch').mockImplementation((input, options = {}) => {
    const url = new URL(String(input))
    const first =
      url.hostname.startsWith('first-') ||
      (url.pathname === '/actions/runner-registration' &&
        new Headers(options.headers).get('authorization') === 'RemoteAuth first')
    return fixtures[first ? 0 : 1].fetch(input, options)
  })
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5000
    while (!predicate()) {
      if (Date.now() > deadline) throw Error('Timed out waiting for competing offers')
      await delay(5)
    }
  }
  try {
    await journal.initialize()
    const lease = (await state.acquire(randomUUID(), 30000))!
    for (const [index, fixture] of fixtures.entries()) {
      const tenant = index === 0 ? 'first' : 'second'
      const scope = decodeScope({
        binding: tenant,
        actor: tenant,
        generation: 1,
        organization: tenant,
        installation: { id: 0, account: { ...fixture.repository.owner, type: 'User' } },
        runners: { kind: 'repository', repository: fixture.repository, allowPrivate: true, allowPublic: false },
      })
      await journal.define(lease, scope)
      const controller = new ScaleSetController(
        state,
        lease,
        scope,
        ['boxlite'],
        journal,
        work,
        {
          service: new ActionsScaleSets('https://github.com/owner/repo', async () => tenant),
          authority: async () => new Set(['repo']),
          creationReady: () => true,
          charged: () => 0,
          policy: async () => ({ limits: [{ domain: 'global', maximum: 1 }] }),
          report: () => {},
          wake: () => {},
        },
        lifetime.signal,
      )
      controllers.push(controller)
      await controller.restore(['boxlite'])
    }
    await until(() => fixtures.every((f) => f.requests.includes('GET /messages')))
    for (const fixture of fixtures) fixture.publish(0, 0, [123])
    await until(() => fixtures.every((f) => f.acknowledged.includes(0) || f.sessions.length > 1))
    expect(fixtures.flatMap((f) => f.acquired).flat()).toHaveLength(1)
    expect((await journal.used('first')) + (await journal.used('second'))).toBe(1)
  } finally {
    lifetime.abort()
    await Promise.all(controllers.map((controller) => controller.close()))
    requests.mockRestore()
    await db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
