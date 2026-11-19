/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { DataSource } from 'typeorm'
import { PostgresStateDatabase, postgresStateTable } from './state/postgres'
import { CredentialSource } from './credentials'
import { GitHubAppSource, GitHubInstallation } from './github-app'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { GitHubExecutionBackend } from './execution/backend'
import { ExecutionJournal } from './execution/journal'
import { ExecutionScope } from './execution/model'
import { Listener, ListenerHost } from './listener'
import { scaleSetBindings } from './scale-set-controller'
import { SqliteStateDatabase } from './state/sqlite'
import { ListenerState } from './state/store'
import { ConfirmedWorkerAbsent, WorkerExecutor, WorkerState } from './worker'

/** Public wire shapes. No external runner or installation is needed by this fixture. */
class ActionsFixture {
  readonly repository = { id: 21, name: 'repo', owner: { id: 7, login: 'owner' }, private: true }
  readonly queue = 'https://broker.actions.githubusercontent.com/messages'
  readonly service = 'https://pipelines.actions.githubusercontent.com/tenant'
  readonly sessions: string[] = []
  readonly runners = new Map<string, { id: number; name: string; runnerScaleSetId: number }>()
  readonly acknowledged: number[] = []
  readonly requests: string[] = []
  readonly acquired: number[][] = []
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
          requestLabels: ['boxlite'],
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
      if (method === 'POST') return Response.json((this.definition = { ...data, id: 9 }))
      return Response.json({ count: this.definition ? 1 : 0, value: this.definition ? [this.definition] : [] })
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
        if (scenario === 'checks an organization runner group') {
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
        const host: ListenerHost = {
          discover: async () => ({ scopes: [scope], completed: [], pending: false, ready: true }),
          backend: async (original, lease) =>
            new GitHubExecutionBackend(state, lease, original, source, { workers, authorize: async () => {} }, [
              'boxlite',
            ]),
          report: (error, operation) => errors.push(operation + ': ' + String(error)),
          scan: jest.fn(),
          accept: jest.fn(),
        }
        const start = () => {
          const controller = new AbortController()
          const task = new Listener({
            state,
            host,
            worker: { image: 'jitbox', cpus: 2, memoryMiB: 2048, labels: ['boxlite'] },
            capacity: { resolve: async () => ({ limits: [{ maximum: 2, domain: 'organization' }] }) },
            scaleSets: scaleSetBindings(JSON.stringify({ [scope.binding]: ['boxlite'] })),
            timing: { tickMs: 5, leaseMs: 450 },
          }).run(controller.signal)
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
          stop = start()
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
