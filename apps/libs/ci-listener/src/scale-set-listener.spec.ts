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
import { WorkQueue } from './execution/work-queue'
import { ExecutionJournal } from './execution/journal'
import { scopeKey, decodeScope, ExecutionScope } from './execution/model'
import { Listener, ListenerHost } from './listener'
import { ScaleSetController, ScaleSetWork } from './scale-set-controller'
import { ActionsScaleSets } from './scale-set-client'
import { SqliteStateDatabase } from './state/sqlite'
import { StateCorrupt } from './state/database'
import { ExecutionLease, ListenerState, StateCheck } from './state/store'
import { ListenerInbox, verifyWebhook } from './webhook'
import { ConfirmedWorkerAbsent, ConfirmedWorkerCreationRejected, WorkerExecutor, WorkerState } from './worker'

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
  rejectAcquisition = new Set<number>()
  loseRetirementReply = false
  loseBeforeAcquire = false
  interruptAcquisition?: () => void
  acquiredCount: number | undefined = 0
  initialAcquired?: number
  readonly throttledSets = new Map<number, number>()
  rejectNextPoll = false
  target = 0
  definition?: { id: number; name: string; labels: unknown[]; runnerGroupId: number }
  installation?: GitHubInstallation
  private messages: (object | null)[] = []
  idle() {
    this.messages.push(null)
    this.waiter?.()
  }
  private waiter?: () => void
  publish(id: number, assigned: number, offers: number[] = [], extra: object[] = []) {
    const events = [
      ...extra,
      ...offers.map((runnerRequestId) => ({
        messageType: 'JobAvailable',
        runnerRequestId,
        ownerName: 'owner',
        repositoryName: 'repo',
        requestLabels: this.labels,
      })),
    ]
    this.publishRaw(id, assigned, JSON.stringify(events))
  }
  publishRaw(id: number, assigned: number, body: string) {
    this.target = assigned
    this.messages.push({
      messageId: id,
      messageType: 'RunnerScaleSetJobMessages',
      statistics: { totalAssignedJobs: assigned },
      body,
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
      return runner
        ? Response.json({ ...runner, status: 'online', busy: !this.loseRetirementReply })
        : new Response(null, { status: 404 })
    }
    if (method === 'DELETE' && this.loseRetirementReply && /\/actions\/runners\/\d+$/.test(path)) {
      const original = [...this.runners.values()].find((runner) => path.endsWith('/' + runner.id))
      if (!original) throw Error('Missing original runner')
      this.runners.delete(original.name)
      throw Error('Lost DELETE reply after retirement')
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
    const setId = Number(path.match(/\/runnerscalesets\/(\d+)$/)?.[1])
    if (method === 'GET' && this.throttledSets.has(setId)) {
      this.throttledSets.set(setId, this.throttledSets.get(setId)! + 1)
      return new Response(null, { status: 429, headers: { 'retry-after': '60' } })
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
      return Response.json({
        ...this.definition,
        statistics: { totalAssignedJobs: this.target, totalAcquiredJobs: this.acquiredCount },
      })
    if (path.endsWith('/9/sessions') && method === 'POST') {
      const sessionId = randomUUID()
      this.sessions.push(sessionId)
      return Response.json({
        sessionId,
        messageQueueUrl: this.queue,
        messageQueueAccessToken: 'session',
        statistics: { totalAssignedJobs: this.target, totalAcquiredJobs: this.initialAcquired },
      })
    }
    if (method === 'DELETE' && path.includes('/9/sessions/')) return new Response(null, { status: 204 })
    if (path === '/messages' && method === 'GET') {
      if (this.rejectNextPoll) {
        this.rejectNextPoll = false
        return new Response('private response body', { status: 503 })
      }
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
      const message = this.messages.shift()
      return message === null ? new Response(null, { status: 202 }) : Response.json(message)
    }
    if (path.startsWith('/messages/') && method === 'DELETE') {
      this.acknowledged.push(Number(path.split('/').at(-1)))
      return new Response(null, { status: 204 })
    }
    if (path.endsWith('/acquirejobs')) {
      if (this.loseBeforeAcquire) {
        this.loseBeforeAcquire = false
        throw Error('Request did not reach Actions')
      }
      this.acquired.push(data)
      if (this.interruptAcquisition) {
        this.target += data.length
        this.interruptAcquisition()
        this.interruptAcquisition = undefined
        throw Error('Lost acquisition reply')
      }
      const accepted = data.filter((id: number) => !this.rejectAcquisition.has(id))
      return Response.json({ count: accepted.length, value: accepted })
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
  'subtracts assigned jobs from acquired holds on an idle poll',
  'subtracts assigned jobs from acquired holds on reconnect',
  'reconciles acquired and replayed demand',
  'continues assigning workers when the event observer throws',
  'traces a failed poll with its scale set and HTTP status',
  'starts confirmed jobs when the planner first reads after the poll fails',
  'retries a confirmed create rejection after the offline target has left planning',
  'honors a newer zero before a delayed create rejection',
  'cancels disconnected reservations when GitHub confirms zero before dispatch',
  'backs off failed Box startup',
  'backs off a Box exit without a status code',
  'checks an organization runner group',
  'recovers an acknowledged JIT upload',
  'takes over after acquisition before the ledger commit',
  'retries a redelivered offer with its original charged slot',
  'releases an interrupted request omitted from the replacement session',
  'retains an interrupted acquisition that Actions still counts without a reoffer',
  'keeps the second hold after a delayed start confirms the first assignment',
  'releases a rejected redelivery for another offer',
  'uses the free slot after a partially accepted retry',
  'reconciles a partial acquisition after an idle poll reduces holds',
  'acquires a reoffered request excluded from a partial reply',
  'requires spare quota to reacquire one of several ambiguous requests',
  'preserves an uncertain acquisition still counted by Actions',
  'holds accepted quota through idle polls and an owner restart',
  'reuses a held slot after cancellation between statistics samples',
  'returns an undispatched reservation for a deleted set',
  'rotates idle sessions through every page of restored specifications',
  'credits work only to the original JIT runner',
  'rejects conflicting persisted request identities on restore',
  'opens a healthy specification while 64 sessions back off',
  'releases a confirmed request that settled while disconnected',
  'preserves a confirmed acquisition reported by the new session',
  'recovers one confirmed hold after two accepted requests settle partially offline',
  'releases remaining ambiguous holds after a second reconnect reports zero',
  'releases an accepted hold after a missed lifecycle event on the same session',
  'honors a quota pause before retrying an unknown acquisition',
  'recovers idle retirement after a lost DELETE reply',
  'replaces the retired runner when demand returns after a lost DELETE reply',
  'rejects a charged retry against a stale quota record',
  'rejects a charged retry when its assigned Box becomes absent',
  'rejects a charged retry when its assigned Box starts closing',
  'rejects a charged retry when its last reserved worker starts',
  'requires an original set reservation when a drained request is reoffered',
  'retries a charged slot with 98 policy checks',
  'rechecks shrinking quota after a long poll',
  'leaves the remaining quota for already assigned demand',
  'starts an organization worker with the custom resource label',
  'discovers a custom resource label from a standalone PAT repository scan',
  'consumes signed request IDs across offers and a journal restart',
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
        const observe = jest.fn()
        if (scenario === 'continues assigning workers when the event observer throws')
          observe.mockImplementation(() => {
            throw new Error('logging unavailable')
          })
        const host: ListenerHost = {
          observe,
          discover: async () => ({ scopes: [scope], completed: [], pending: false, ready: true }),
          backend: async (original, lease) =>
            new GitHubExecutionBackend(state, lease, original, source, { workers, authorize: async () => {} }, [
              'boxlite',
            ]),
          report: (error, operation) => errors.push(operation + ': ' + String(error)),
          scan: jest.fn(),
          accept: (event) => inbox.receive(event),
        }
        const report = jest.spyOn(host, 'report')
        let listener: Listener
        let maximum = 2
        let policyOwner: ExecutionLease | undefined
        let policyChecks: StateCheck[] | undefined
        const start = () => {
          const controller = new AbortController()
          listener = new Listener({
            state,
            host,
            worker: { image: 'jitbox', cpus: 2, memoryMiB: 2048, labels: ['boxlite'] },
            capacity: {
              resolve: async ({ lease }) => {
                policyOwner = lease
                return { limits: [{ maximum, domain: 'organization' }], checks: policyChecks }
              },
            },
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
          if (
            scenario === 'rejects a charged retry when its assigned Box becomes absent' ||
            scenario === 'rejects a charged retry when its assigned Box starts closing' ||
            scenario === 'rejects a charged retry when its last reserved worker starts'
          ) {
            const owner = (await state.acquire(randomUUID(), 30000))!
            const key = await journal.define(owner, scope)
            const peer = await journal.define(owner, { ...scope, binding: 'peer', organization: 'peer' })
            const policy = { limits: [{ domain: 'global' as const, maximum: 2 }] }
            const supply = { labels: ['boxlite'], scaleSet: 9 }
            const slot = (await journal.reserve(owner, key, null, policy, supply))!
            const dispatched = await journal.advance(owner, slot.record.key, slot.record.version, {
              effect: { id: randomUUID(), kind: 'box-create' },
              box: { phase: 'requested', id: null },
            })
            const assigned = await journal.advance(owner, slot.record.key, dispatched.record.version, {
              box: { phase: 'known', id: 'assigned-box' },
            })
            fixture.target = 1
            fixture.loseBeforeAcquire = true
            const controller = new ScaleSetController(
              state,
              owner,
              decodeScope(scope),
              ['boxlite'],
              journal,
              new ScaleSetWork(),
              {
                service: new ActionsScaleSets('https://github.com/owner/repo', async () => 'local-token'),
                authority: async () => new Set(['repo']),
                charged: () => 1,
                creationReady: () => true,
                policy: async () => policy,
                report: (error) => errors.push(String(error)),
                wake: () => {},
              },
              new AbortController().signal,
            )
            stop = () => controller.close()
            await controller.restore()
            await until(() => fixture.requests.includes('GET /messages'))
            fixture.publish(1, 1, [123])
            await until(() => fixture.sessions.length === 2)
            expect(await journal.used('tenant')).toBe(2)
            const becomesAbsent = scenario.endsWith('becomes absent')
            const commit = state.commit.bind(state)
            let intervened = false
            jest.spyOn(state, 'commit').mockImplementation(async (...args) => {
              const [, changes, checks] = args
              if (!intervened && checks !== undefined && changes[0].key.startsWith('scale-set/')) {
                intervened = true
                if (scenario === 'rejects a charged retry when its last reserved worker starts') {
                  const { rows } = await journal.workers(owner, key)
                  const reserved = rows.find((row) => row.value.box.phase === 'none')!
                  await journal.advance(owner, reserved.record.key, reserved.record.version, {
                    effect: { id: randomUUID(), kind: 'box-create' },
                    box: { phase: 'requested', id: null },
                  })
                } else {
                  await journal.advance(
                    owner,
                    assigned.record.key,
                    assigned.record.version,
                    becomesAbsent ? { box: { phase: 'absent', id: 'assigned-box' } } : { closing: true },
                  )
                  if (becomesAbsent) await journal.reserve(owner, peer, null, policy, { ...supply, scaleSet: 8 })
                }
              }
              return commit(...args)
            })
            fixture.publish(1, 1, [123])
            await until(() => fixture.acknowledged.includes(1) || fixture.sessions.length > 2)
            expect(intervened).toBe(true)
            expect(await journal.used('peer')).toBe(becomesAbsent ? 1 : 0)
            expect(fixture.acquired).toEqual([])
            return
          }
          if (scenario === 'opens a healthy specification while 64 sessions back off') {
            const owner = (await state.acquire(randomUUID(), 600))!
            const key = await journal.define(owner, scope)
            for (let n = 1; n <= 64; n++) {
              fixture.throttledSets.set(100 + n, 0)
              await state.commit(owner, [
                {
                  key: 'scale-set/' + key.slice(6) + '/boxlite-1vcpu-1gbmem-' + n + 'gbdisk',
                  expected: null,
                  payload: {
                    name: 'boxlite-' + randomUUID().replaceAll('-', ''),
                    set: 100 + n,
                    assigned: 1,
                    held: 0,
                    pending: [],
                    message: null,
                    session: null,
                  },
                },
              ])
            }
            stop = start()
            await until(
              () =>
                fixture.sessions.length === 1 && [...fixture.throttledSets.values()].every((attempts) => attempts > 0),
            )
            expect(fixture.definition?.labels).toEqual(expect.arrayContaining([{ name: 'boxlite', type: 'System' }]))
            await delay(1550)
            expect([...fixture.throttledSets.values()]).toEqual(Array(64).fill(1))
            return
          }
          if (scenario === 'rejects conflicting persisted request identities on restore') {
            const owner = (await state.acquire(randomUUID(), 30000))!
            const key = await journal.define(owner, scope)
            const setName = 'boxlite-' + randomUUID().replaceAll('-', '')
            await state.commit(owner, [
              {
                key: 'scale-set/' + key.slice(6) + '/boxlite',
                expected: null,
                payload: {
                  name: setName,
                  set: 9,
                  assigned: 0,
                  held: 2,
                  message: null,
                  session: null,
                  pending: [
                    { id: '123', phase: 'requested' },
                    { id: '123', phase: 'accepted' },
                  ],
                },
              },
            ])
            const controller = new ScaleSetController(
              state,
              owner,
              decodeScope(scope),
              ['boxlite'],
              journal,
              new ScaleSetWork(),
              {
                service: new ActionsScaleSets('https://github.com/owner/repo', async () => 'local-token'),
                authority: async () => new Set(['repo']),
                creationReady: () => true,
                charged: () => 0,
                policy: async () => ({ limits: [] }),
                report: jest.fn(),
                wake: jest.fn(),
              },
              new AbortController().signal,
            )
            stop = () => controller.close()
            await expect(controller.restore()).rejects.toBeInstanceOf(StateCorrupt)
            expect(fixture.requests).toEqual([])
            return
          }
          if (scenario === 'rotates idle sessions through every page of restored specifications') {
            const owner = (await state.acquire(randomUUID(), 600))!
            const key = await journal.define(owner, scope)
            const labels = Array.from({ length: 101 }, (_, index) => 'boxlite-1vcpu-1gbmem-' + (index + 1) + 'gbdisk')
            for (const label of labels) {
              await state.commit(owner, [
                {
                  key: 'scale-set/' + key.slice(6) + '/' + label,
                  expected: null,
                  payload: {
                    name: 'boxlite-' + randomUUID().replaceAll('-', ''),
                    set: null,
                    assigned: 0,
                    held: 0,
                    pending: [],
                    message: null,
                    session: null,
                  },
                },
              ])
            }
            for (let i = 0; i < 64; i++) fixture.idle()
            stop = start()
            const opened = () =>
              new Set(
                observe.mock.calls
                  .map(([event]) => event)
                  .filter((event) => event.event === 'ci-scale-set-session-opened')
                  .map((event) => event.label),
              )
            await until(() => opened().size === labels.length + 1)
            expect(opened()).toEqual(new Set(['boxlite', ...labels]))
            return
          }
          if (scenario === 'returns an undispatched reservation for a deleted set') {
            const owner = (await state.acquire(randomUUID(), 600))!
            const originalScope = await journal.define(owner, scope)
            await state.commit(owner, [
              {
                key: 'scale-set/' + originalScope.slice(6) + '/boxlite',
                expected: null,
                payload: {
                  name: 'boxlite-' + 'a'.repeat(32),
                  set: 8,
                  assigned: 1,
                  held: 0,
                  pending: [],
                  message: null,
                  session: null,
                },
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
          if (
            scenario === 'retries a confirmed create rejection after the offline target has left planning' ||
            scenario === 'honors a newer zero before a delayed create rejection'
          ) {
            const cancel = scenario === 'honors a newer zero before a delayed create rejection'
            fixture.target = 1
            let pollFailed = false
            let idle = false
            let sawZero = false
            const targets = ScaleSetController.prototype.targets
            const reads = jest.spyOn(ScaleSetController.prototype, 'targets').mockImplementation(function (
              this: ScaleSetController,
            ) {
              const result = targets.call(this)
              if (pollFailed && result.length === 0) idle = true
              if (fixture.sessions.length > 1 && result.some((target) => target.assigned === 0)) sawZero = true
              return result
            })
            fetch.mockImplementation(async (input, opts = {}) => {
              if (new URL(String(input)).pathname === '/messages' && !pollFailed) {
                pollFailed = true
                return cancel
                  ? new Response(null, { status: 503 })
                  : new Response(null, { status: 429, headers: { 'retry-after': '60' } })
              }
              return fixture.fetch(input, opts)
            })
            jest.mocked(workers.create).mockImplementationOnce(async ({ name }) => {
              const row = await journal.allocation(policyOwner!, 'worker/' + name.slice(7))
              fixture.target = 0
              await until(() => (cancel ? sawZero : idle))
              throw new ConfirmedWorkerCreationRejected(row!.value.effect!.id, 'before-persistence', 503)
            })
            try {
              stop = start()
              await until(() => observe.mock.calls.some(([event]) => event.event === 'ci-worker-create-rejected'))
              if (cancel) {
                await delay(1150)
                expect(workers.create).toHaveBeenCalledTimes(1)
                expect(await journal.used(scope.organization)).toBe(0)
              } else {
                await until(() => delivered.size === 1)
                expect(workers.create).toHaveBeenCalledTimes(2)
                expect(fixture.sessions).toHaveLength(1)
              }
            } finally {
              reads.mockRestore()
            }
            return
          }
          fixture.rejectNextPoll = scenario === 'traces a failed poll with its scale set and HTTP status'
          if (
            scenario === 'starts confirmed jobs when the planner first reads after the poll fails' ||
            scenario === 'cancels disconnected reservations when GitHub confirms zero before dispatch'
          ) {
            const cancel = scenario === 'cancels disconnected reservations when GitHub confirms zero before dispatch'
            const deferredWorkers = new Set<string>()
            let zeroVisible = false
            const enqueue = WorkQueue.prototype.enqueue
            const dispatch = jest.spyOn(WorkQueue.prototype, 'enqueue').mockImplementation(function (
              this: WorkQueue,
              key,
              revision,
              run,
            ) {
              if (key.startsWith('worker/') && !deferredWorkers.has(key)) {
                deferredWorkers.add(key)
                if (!cancel) return false
                return enqueue.call(this, key, revision, async (wait) => {
                  await until(() => zeroVisible)
                  return run(wait)
                })
              }
              return enqueue.call(this, key, revision, run)
            })
            fixture.target = 2
            let firstRead = false
            let pollFailed = false
            const targets = ScaleSetController.prototype.targets
            const reads = jest.spyOn(ScaleSetController.prototype, 'targets').mockImplementation(function (
              this: ScaleSetController,
            ) {
              const result = targets.call(this)
              firstRead = true
              if (fixture.sessions.length > 1 && result.some((target) => target.assigned === 0)) zeroVisible = true
              return result
            })
            const recover = journal.activeScopes
            let firstCycle = true
            const cycles = jest.spyOn(ExecutionJournal.prototype, 'activeScopes').mockImplementation(async function (
              this: ExecutionJournal,
              ...args
            ) {
              if (!firstCycle) await until(() => pollFailed)
              firstCycle = false
              return recover.apply(this, args)
            })
            fetch.mockImplementation(async (input, opts = {}) => {
              const path = new URL(String(input)).pathname
              if (path.endsWith('/9/sessions') && opts.method === 'POST') await until(() => firstRead)
              if (path === '/messages' && !pollFailed)
                return cancel
                  ? new Response(null, { status: 503 })
                  : new Response(null, { status: 429, headers: { 'retry-after': '60' } })
              return fixture.fetch(input, opts)
            })
            report.mockImplementation((_error, _operation, context) => {
              if (context?.stage === 'poll') pollFailed = true
            })
            try {
              stop = start()
              await until(() => pollFailed)
              if (cancel) {
                await until(() => deferredWorkers.size > 0)
                expect(await journal.used(scope.organization)).toBe(2)
                fixture.target = 0
                await until(async () => zeroVisible && (await journal.used(scope.organization)) === 0)
                expect(observe).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'ci-worker-box-known' }))
                expect(delivered.size).toBe(0)
              } else {
                await until(() => delivered.size === 2)
                expect(fixture.sessions).toHaveLength(1)
                expect(await journal.used(scope.organization)).toBe(2)
                expect(deferredWorkers.size).toBe(2)
              }
            } finally {
              pollFailed = true
              zeroVisible = true
              dispatch.mockRestore()
              reads.mockRestore()
              cycles.mockRestore()
            }
            return
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
          if (scenario === 'traces a failed poll with its scale set and HTTP status') {
            await until(() => fixture.sessions.length === 2)
            expect(report).toHaveBeenCalledWith(
              expect.any(Error),
              'scale-set-session',
              expect.objectContaining({
                stage: 'poll',
                scaleSet: 9,
                label: 'boxlite',
                scope: scopeKey(decodeScope(scope)),
                httpStatus: 503,
              }),
            )
            expect(JSON.stringify(report.mock.calls)).not.toContain('private response body')
            return
          }
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
            expect(observe).toHaveBeenCalledWith(
              expect.objectContaining({ event: 'ci-scale-set-message-received', offered: 1 }),
            )
            expect(observe).not.toHaveBeenCalledWith(
              expect.objectContaining({ event: 'ci-scale-set-first-reservation' }),
            )
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
          if (
            scenario === 'subtracts assigned jobs from acquired holds on an idle poll' ||
            scenario === 'subtracts assigned jobs from acquired holds on reconnect'
          ) {
            fixture.publish(1, 0, [11, 12])
            await until(() => fixture.acknowledged.includes(1))
            fixture.publish(2, 1, [], [{ messageType: 'JobAssigned', runnerRequestId: 11 }])
            await until(() => fixture.acknowledged.includes(2) && delivered.size === 1)
            const polls = () => fixture.requests.filter((request) => request === 'GET /messages').length
            const idlePoll = async () => {
              const before = polls()
              fixture.idle()
              await until(() => polls() > before)
            }
            fixture.acquiredCount = 2
            await idlePoll()
            expect(await journal.used('tenant')).toBe(2)
            fixture.acquiredCount = 1
            if (scenario === 'subtracts assigned jobs from acquired holds on reconnect') {
              await stop()
              const before = polls()
              fixture.initialAcquired = 1
              stop = start()
              await until(() => polls() > before)
            } else await idlePoll()
            expect(await journal.used('tenant')).toBe(1)
            expect(fixture.acquired).toEqual([[11, 12]])
            expect(delivered.size).toBe(1)
            return
          }
          if (scenario === 'releases an accepted hold after a missed lifecycle event on the same session') {
            maximum = 1
            fixture.acquiredCount = 1
            fixture.publish(1, 0, [123])
            await until(() => fixture.acknowledged.includes(1))
            expect(await journal.used('tenant')).toBe(1)
            fixture.acquiredCount = 0
            fixture.idle()
            await until(async () => (await journal.used('tenant')) === 0)
            expect(fixture.sessions).toHaveLength(1)
            return
          }
          if (scenario === 'honors a quota pause before retrying an unknown acquisition') {
            maximum = 1
            fixture.loseBeforeAcquire = true
            fixture.publish(1, 0, [123])
            await until(() => fixture.sessions.length === 2)
            const failure = report.mock.calls.find(([, operation]) => operation === 'scale-set-session')
            expect(failure?.[2]).toMatchObject({ stage: 'acquire', scaleSet: 9, messageId: 1 })
            expect(failure?.[2]).not.toHaveProperty('httpStatus')
            expect(observe).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'ci-scale-set-acquired' }))
            maximum = 0
            fixture.publish(1, 0, [123])
            await until(() => fixture.acknowledged.includes(1))
            expect(fixture.acquired).toEqual([])
            return
          }
          if (
            scenario === 'requires an original set reservation when a drained request is reoffered' ||
            scenario === 'retries a charged slot with 98 policy checks'
          ) {
            maximum = 1
            await until(() => fixture.requests.includes('GET /messages'))
            const budget = scenario === 'retries a charged slot with 98 policy checks'
            if (budget) {
              const records = await state.commit(
                policyOwner!,
                Array.from({ length: 98 }, (_, i) => ({
                  key: 'test/quota/' + i,
                  expected: null,
                  payload: { maximum: 1 },
                })),
              )
              policyChecks = records.map(({ key, version }) => ({ key, version }))
            }
            fixture.loseBeforeAcquire = true
            fixture.publish(1, 0, [123])
            await until(() => fixture.sessions.length === 2)
            if (!budget) {
              const key = await journal.define(policyOwner!, scope)
              const [original] = (await journal.workers(policyOwner!, key)).rows
              const absent = await journal.advance(policyOwner!, original.record.key, original.record.version, {
                closing: true,
                box: { phase: 'absent', id: null },
                runner: { phase: 'absent', id: null },
              })
              await journal.release(policyOwner!, absent.record.key, absent.record.version)
              const other = await journal.reserve(
                policyOwner!,
                key,
                null,
                { limits: [{ domain: 'organization', maximum: 1 }] },
                { labels: ['boxlite-1vcpu-1gbmem-10gbdisk'], scaleSet: 8 },
              )
              expect(other).toBeDefined()
            }
            fixture.publish(1, 0, [123])
            await until(() => fixture.acknowledged.includes(1) || fixture.sessions.length > 2)
            expect(fixture.acquired).toEqual(budget ? [[123]] : [])
            expect(await journal.used('tenant')).toBe(1)
            return
          }
          if (scenario === 'rejects a charged retry against a stale quota record') {
            maximum = 1
            fixture.loseBeforeAcquire = true
            fixture.publish(1, 0, [123])
            await until(() => fixture.sessions.length === 2)
            const [open] = await state.commit(policyOwner!, [
              { key: 'test/quota', expected: null, payload: { maximum: 1 } },
            ])
            policyChecks = [{ key: open.key, version: open.version }]
            await state.commit(policyOwner!, [{ key: open.key, expected: open.version, payload: { maximum: 0 } }])
            fixture.publish(1, 0, [123])
            await until(() => fixture.acknowledged.includes(1) || fixture.sessions.length > 2)
            expect(fixture.acquired).toEqual([])
            return
          }
          if (
            scenario === 'recovers idle retirement after a lost DELETE reply' ||
            scenario === 'replaces the retired runner when demand returns after a lost DELETE reply'
          ) {
            maximum = 1
            fixture.loseRetirementReply = true
            fixture.publish(1, 0, [123])
            await until(() => fixture.acknowledged.includes(1))
            fixture.publish(2, 1)
            await until(() => (workers.deliverJit as jest.Mock).mock.calls.length === 1)
            fixture.publish(3, 0)
            await until(() =>
              fixture.requests.some((path) => path.startsWith('DELETE /repos/owner/repo/actions/runners/')),
            )
            expect(fixture.runners.size).toBe(0)
            await stop()
            const renewed = scenario === 'replaces the retired runner when demand returns after a lost DELETE reply'
            if (renewed) fixture.target = 1
            stop = start()
            if (renewed) {
              await until(() => fixture.runners.size === 1)
              expect(workers.create).toHaveBeenCalledTimes(2)
              expect(boxes.size).toBe(1)
              expect(
                fixture.requests.filter((path) => path.startsWith('DELETE /repos/owner/repo/actions/runners/')),
              ).toHaveLength(1)
              return
            }
            await until(async () => (await journal.used('tenant')) === 0)
            expect(boxes.size).toBe(0)
            return
          }
          if (scenario === 'keeps the second hold after a delayed start confirms the first assignment') {
            maximum = 2
            fixture.publish(1, 0, [11, 12])
            await until(() => fixture.acknowledged.includes(1))
            await stop()
            fixture.target = 1
            stop = start()
            await until(() => fixture.sessions.length === 2)
            fixture.publish(2, 1, [13], [{ messageType: 'JobStarted', runnerRequestId: 11 }])
            await until(() => fixture.acknowledged.includes(2))
            fixture.publish(3, 1, [13])
            await until(() => fixture.acknowledged.includes(3))
            expect(fixture.acquired).toEqual([[11, 12]])
            expect(await journal.used('tenant')).toBe(2)
            return
          }
          if (scenario === 'preserves an uncertain acquisition still counted by Actions') {
            maximum = 1
            fixture.loseBeforeAcquire = true
            fixture.publish(1, 0, [31])
            await until(() => fixture.sessions.length === 2)
            fixture.acquiredCount = 1
            fixture.rejectAcquisition.add(31)
            fixture.publish(1, 0, [31])
            await until(() => fixture.acknowledged.includes(1))
            fixture.publish(2, 0, [32])
            await until(() => fixture.acknowledged.includes(2))
            expect(fixture.acquired).toEqual([[31]])
            expect(await journal.used('tenant')).toBe(1)
            fixture.acquiredCount = 0
            fixture.idle()
            await until(async () => (await journal.used('tenant')) === 0)
            fixture.publish(3, 0, [32])
            await until(() => fixture.acknowledged.includes(3))
            expect(fixture.acquired).toEqual([[31], [32]])
            return
          }
          if (scenario === 'requires spare quota to reacquire one of several ambiguous requests') {
            maximum = 2
            fixture.loseBeforeAcquire = true
            fixture.publish(1, 0, [31, 32])
            await until(() => fixture.sessions.length === 2)
            fixture.acquiredCount = 1
            fixture.rejectAcquisition.add(31)
            fixture.rejectAcquisition.add(32)
            fixture.publish(1, 0, [31, 32])
            await until(() => fixture.acknowledged.includes(1))
            expect(await journal.used('tenant')).toBe(1)
            maximum = 1
            fixture.rejectAcquisition.delete(32)
            fixture.publish(2, 0, [32])
            await until(() => fixture.acknowledged.includes(2))
            expect(fixture.acquired).toEqual([[31, 32]])
            maximum = 2
            for (const message of [3, 4, 5]) {
              fixture.publish(message, 0, [32])
              await until(() => fixture.acknowledged.includes(message))
              if (fixture.acquired.length > 1) break
            }
            expect(fixture.acquired).toEqual([[31, 32], [32]])
            expect(await journal.used('tenant')).toBe(2)
            return
          }
          if (
            scenario === 'uses the free slot after a partially accepted retry' ||
            scenario === 'acquires a reoffered request excluded from a partial reply'
          ) {
            maximum = 2
            fixture.loseBeforeAcquire = true
            fixture.publish(1, 0, [31, 32])
            await until(() => fixture.sessions.length === 2)
            fixture.acquiredCount = 1
            fixture.rejectAcquisition.add(32)
            fixture.publish(1, 0, [31, 32])
            await until(() => fixture.acknowledged.includes(1))
            const next = scenario === 'acquires a reoffered request excluded from a partial reply' ? 32 : 33
            fixture.rejectAcquisition.delete(next)
            for (const message of [2, 3, 4]) {
              fixture.publish(message, 0, [next])
              await until(() => fixture.acknowledged.includes(message))
              if (fixture.acquired.length > 1) break
            }
            expect(fixture.acquired).toEqual([[31, 32], [next]])
            expect(await journal.used('tenant')).toBe(2)
            return
          }
          if (scenario === 'reconciles a partial acquisition after an idle poll reduces holds') {
            maximum = 3
            fixture.publish(1, 0, [31, 32])
            await until(() => fixture.acknowledged.includes(1))
            expect(await journal.used('tenant')).toBe(2)
            fixture.acquiredCount = 1
            fixture.idle()
            await until(async () => (await journal.used('tenant')) === 1)
            fixture.rejectAcquisition.add(31)
            fixture.publish(2, 0, [31, 33])
            await until(() => fixture.acknowledged.includes(2))
            expect(fixture.acquired).toEqual([
              [31, 32],
              [31, 33],
            ])
            await until(async () => (await journal.used('tenant')) === 1)
            fixture.publish(3, 1, [], [{ messageType: 'JobAssigned', runnerRequestId: 33 }])
            await until(() => fixture.acknowledged.includes(3) && delivered.size === 1)
            expect(await journal.used('tenant')).toBe(1)
            return
          }
          if (scenario === 'releases a rejected redelivery for another offer') {
            maximum = 1
            fixture.loseBeforeAcquire = true
            fixture.publish(1, 0, [31])
            await until(() => fixture.sessions.length === 2)
            fixture.rejectAcquisition.add(31)
            fixture.publish(1, 0, [31])
            await until(() => fixture.acknowledged.includes(1))
            fixture.publish(2, 0, [32])
            await until(() => fixture.acknowledged.includes(2))
            expect(fixture.acquired).toEqual([[31], [32]])
            expect(await journal.used('tenant')).toBe(1)
            return
          }
          if (scenario === 'releases remaining ambiguous holds after a second reconnect reports zero') {
            maximum = 2
            fixture.publish(1, 0, [31, 32])
            await until(() => fixture.acknowledged.includes(1))
            await stop()
            fixture.initialAcquired = 1
            stop = start()
            await until(() => fixture.sessions.length === 2)
            await until(async () => (await journal.used('tenant')) === 1)
            await stop()
            fixture.initialAcquired = 0
            fixture.acquiredCount = undefined
            stop = start()
            await until(() => fixture.sessions.length === 3)
            await until(async () => (await journal.used('tenant')) === 0)
            fixture.publish(2, 0, [33, 34])
            await until(() => fixture.acknowledged.includes(2))
            expect(fixture.acquired).toEqual([
              [31, 32],
              [33, 34],
            ])
            return
          }
          if (scenario === 'recovers one confirmed hold after two accepted requests settle partially offline') {
            maximum = 2
            fixture.publish(1, 0, [31, 32])
            await until(() => fixture.acknowledged.includes(1))
            await stop()
            fixture.initialAcquired = 1
            fixture.acquiredCount = 1
            stop = start()
            await until(() => fixture.sessions.length === 2)
            for (const message of [2, 3, 4]) {
              fixture.publish(message, 0, [32])
              await until(() => fixture.acknowledged.includes(message))
              if (fixture.acquired.length > 1) break
            }
            expect(fixture.acquired).toEqual([[31, 32], [32]])
            expect(await journal.used('tenant')).toBe(2)
            return
          }
          if (
            scenario === 'releases a confirmed request that settled while disconnected' ||
            scenario === 'preserves a confirmed acquisition reported by the new session'
          ) {
            maximum = 1
            fixture.publish(1, 0, [31])
            await until(() => fixture.acknowledged.includes(1))
            await stop()
            const retained = scenario === 'preserves a confirmed acquisition reported by the new session'
            fixture.initialAcquired = retained ? 1 : 0
            stop = start()
            await until(() => fixture.sessions.length === 2)
            for (const message of [2, 3, 4]) {
              fixture.publish(message, 0, [32])
              await until(() => fixture.acknowledged.includes(message))
              if (fixture.acquired.length > 1) break
            }
            expect(fixture.acquired).toEqual(retained ? [[31]] : [[31], [32]])
            expect(await journal.used('tenant')).toBe(1)
            return
          }
          if (scenario === 'consumes signed request IDs across offers and a journal restart') {
            const ids = ['-9223372036854775808', '9223372036854775807']
            const offer =
              '[' +
              ids
                .map(
                  (id) =>
                    `{"messageType":"JobAvailable","runnerRequestId":${id},"ownerName":"owner","repositoryName":"repo","requestLabels":["boxlite"]}`,
                )
                .join(',') +
              ']'
            const acquired: string[] = []
            fetch.mockImplementation((input, options = {}) => {
              if (!new URL(String(input)).pathname.endsWith('/acquirejobs')) return fixture.fetch(input, options)
              const body = String(options.body)
              acquired.push(body)
              return Promise.resolve(new Response('{"count":2,"value":' + body + '}'))
            })
            fixture.acquiredCount = 2
            fixture.publishRaw(1, 0, offer)
            await until(
              () =>
                fixture.acknowledged.includes(1) || report.mock.calls.some(([, , detail]) => detail?.stage === 'poll'),
            )
            expect(fixture.acknowledged).toContain(1)
            expect(acquired).toEqual(['[' + ids.join(',') + ']'])
            fixture.publishRaw(2, 0, offer)
            await until(() => fixture.acknowledged.includes(2))
            expect(acquired).toHaveLength(1)
            expect(fixture.sessions).toHaveLength(1)
            await stop()
            fixture.initialAcquired = 2
            stop = start()
            await until(() => fixture.sessions.length === 2)
            fixture.publishRaw(3, 0, offer)
            await until(() => fixture.acknowledged.includes(3))
            expect(acquired).toHaveLength(1)
            fixture.acquiredCount = 0
            const completed = ids.map((id) => `{"messageType":"JobCompleted","runnerRequestId":${id}}`)
            fixture.publishRaw(4, 0, '[' + completed.join(',') + ']')
            await until(() => fixture.acknowledged.includes(4))
            await until(async () => (await journal.used('tenant')) === 0)
            expect(fixture.sessions).toHaveLength(2)
            expect(report).not.toHaveBeenCalledWith(
              expect.anything(),
              'scale-set-session',
              expect.objectContaining({ stage: 'poll' }),
            )
            return
          }
          if (scenario === 'holds accepted quota through idle polls and an owner restart') {
            fixture.acquiredCount = undefined
            maximum = 1
            fixture.publish(1, 0, [123])
            await until(() => fixture.acknowledged.includes(1))
            expect(fixture.acquired).toEqual([[123]])
            const checkHold = async (id: number) => {
              fixture.idle()
              fixture.publish(id, 0, [124])
              await until(() => fixture.acknowledged.includes(id))
              expect(fixture.acquired).toEqual([[123]])
              expect(await journal.used('tenant')).toBe(1)
              expect(workers.create).not.toHaveBeenCalled()
            }
            await checkHold(2)
            await stop()
            stop = start()
            await until(() => fixture.sessions.length === 2)
            await checkHold(3)
            fixture.publish(4, 0, [], [{ messageType: 'JobCompleted', runnerRequestId: 123 }])
            await until(() => fixture.acknowledged.includes(4))
            await until(async () => (await journal.used('tenant')) === 0)
            fixture.publish(5, 0, [124])
            await until(() => fixture.acknowledged.includes(5))
            expect(fixture.acquired).toEqual([[123], [124]])
            return
          }
          if (
            scenario === 'releases an interrupted request omitted from the replacement session' ||
            scenario === 'retains an interrupted acquisition that Actions still counts without a reoffer'
          ) {
            maximum = 1
            fixture.loseBeforeAcquire = true
            fixture.publish(1, 0, [31])
            await until(() => fixture.sessions.length === 2)
            const owned = scenario === 'retains an interrupted acquisition that Actions still counts without a reoffer'
            fixture.acquiredCount = owned ? 1 : 0
            fixture.idle()
            fixture.publish(2, 0, [32])
            await until(() => fixture.acknowledged.includes(2))
            if (owned) {
              expect(fixture.acquired).toEqual([])
              expect(await journal.used('tenant')).toBe(1)
              fixture.acquiredCount = 0
              fixture.idle()
            }
            for (const message of [3, 4, 5]) {
              fixture.publish(message, 0, [32])
              await until(() => fixture.acknowledged.includes(message))
              if (fixture.acquired.length) break
            }
            expect(fixture.acquired).toEqual([[32]])
            expect(await journal.used('tenant')).toBe(1)
            return
          }
          if (scenario === 'retries a redelivered offer with its original charged slot') {
            maximum = 1
            fixture.loseBeforeAcquire = true
            fixture.publish(1, 0, [123])
            await until(() => fixture.sessions.length === 2)
            expect(await journal.used('tenant')).toBe(1)
            fixture.publish(1, 0, [123, 124])
            await until(() => fixture.acknowledged.includes(1))
            expect(fixture.acquired).toEqual([[123]])
            expect(await journal.used('tenant')).toBe(1)
            return
          }
          if (scenario === 'credits work only to the original JIT runner') {
            fixture.publish(1, 1)
            await until(() => delivered.size === 1)
            const [runner] = fixture.runners.values()
            const allocationKey = 'worker/' + runner.name.slice(7)
            const started = { messageType: 'JobStarted', runnerName: runner.name, runnerId: runner.id }
            fixture.publish(
              2,
              1,
              [],
              [
                { ...started, runnerId: runner.id + 1 },
                { ...started, runnerName: 'ci-jit-' + '0'.repeat(32) },
              ],
            )
            await until(() => fixture.acknowledged.includes(2))
            expect((await journal.allocation(policyOwner!, allocationKey))!.value.runner.worked).not.toBe(true)
            fixture.publish(3, 1, [], [started, { ...started, messageType: 'JobCompleted' }])
            await until(() => fixture.acknowledged.includes(3))
            expect((await journal.allocation(policyOwner!, allocationKey))!.value.runner.worked).toBe(true)
            expect(await journal.used('tenant')).toBe(1)
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
          if (scenario === 'reconciles acquired and replayed demand') {
            await until(() => observe.mock.calls.filter(([e]) => e.event === 'ci-worker-jit-delivered').length === 2)
            const events = observe.mock.calls.map(([event]) => event)
            const context = { scope: scopeKey(decodeScope(scope)), scaleSet: 9, label: 'boxlite' }
            const timeline = events.filter((e) => e.event.startsWith('ci-scale-set-'))
            expect(timeline.slice(0, 5)).toMatchObject([
              { event: 'ci-scale-set-session-opened', ...context, assigned: 0 },
              { event: 'ci-scale-set-poll-started', ...context, capacity: 2 },
              { event: 'ci-scale-set-message-received', ...context, messageId: 0, offered: 5 },
              {
                event: 'ci-scale-set-first-reservation',
                ...context,
                messageId: 0,
                allocation: expect.stringMatching(/^worker\//),
              },
              { event: 'ci-scale-set-acquired', ...context, messageId: 0, attempted: 2, accepted: 2 },
            ])
            for (const event of ['ci-worker-box-known', 'ci-worker-runner-known', 'ci-worker-jit-delivered']) {
              expect(events.filter((e) => e.event === event)).toHaveLength(2)
            }
            expect(JSON.stringify(events)).not.toMatch(/local-token|messageQueueAccessToken|private response body/)
          }
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
      await controller.restore()
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
