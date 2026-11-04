/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { testCapacity } from '../tests/capacity'
import { createHmac, generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionJournal } from './execution/journal'
import { ExecutionScope } from './execution/model'
import { Listener, ListenerBackend, ListenerHost } from './listener'
import { JitRegistration } from './runners'
import { SqliteStateDatabase } from './state/sqlite'
import { ExecutionLease, ListenerState } from './state/store'
import { ListenerInbox, verifyWebhook } from './webhook'
import { AppDeliveryRecovery } from './replay/recovery'
import { GitHubAppSource } from './github-app'
import { ConfirmedWorkerAbsent, ConfirmedWorkerCreationRejected } from './worker'
import { CapacityRequest } from './capacity'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { resolve, promise }
}
describe('CI shared Listener orchestration', () => {
  let directory: string,
    db: SqliteStateDatabase,
    state: ListenerState,
    listener: Listener,
    host: ListenerHost,
    backend: ListenerBackend,
    lease: ExecutionLease,
    namespace: string,
    scope: ExecutionScope,
    delivered: ReturnType<typeof deferred>,
    abort: AbortController
  const settings = { image: 'runner-test', cpus: 2, memoryMiB: 2048, labels: ['boxlite-ci-runner'] }
  const notification = (job = 55, installation = 1, account = 7, repository = 21) => {
    const secret = Buffer.alloc(32, 1),
      raw = Buffer.from(
        JSON.stringify({
          action: 'queued',
          installation: { id: installation },
          repository: { id: repository, owner: { id: account } },
          workflow_job: { id: job, run_id: 33, status: 'queued', labels: ['boxlite-ci-runner'] },
        }),
      )
    return verifyWebhook(
      {
        raw,
        delivery: randomUUID(),
        event: 'workflow_job',
        signature: 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex'),
      },
      secret,
    )!
  }
  const make = () =>
    new Listener({
      state,
      host,
      worker: settings,
      capacity: { resolve: async () => testCapacity({ account: 1, tenant: 2 }) },
      timing: { tickMs: 1, leaseMs: 3000 },
    })
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'ci-listener-'))
    db = new SqliteStateDatabase(directory)
    namespace = 'app:' + randomUUID()
    state = new ListenerState(db, namespace)
    abort = new AbortController()
    delivered = deferred()
    scope = {
      binding: 'binding',
      generation: 1,
      organization: 'tenant',
      actor: 'actor',
      installation: { id: 1, account: { id: 7, login: 'owner', type: 'User' } },
      runners: {
        kind: 'repository',
        repository: { id: 21, owner: { id: 7, login: 'owner' }, name: 'repo', private: true },
        allowPublic: false,
      },
    }
    const inbox = new ListenerInbox(state),
      boxes = new Map<string, { box_id: string; status: string }>()
    backend = {
      admit: jest.fn(async () => {}),
      job: jest.fn(async (notice) => ({
        ...notice,
        status: 'queued' as const,
        labels: ['boxlite-ci-runner'],
        runner: null,
      })),
      queued: jest.fn(async () => []),
      close: jest.fn(async () => {}),
      workers: {
        create: jest.fn(async (launch) => {
          const box = { box_id: randomUUID(), status: 'running' }
          boxes.set(launch.name, box)
          return box
        }),
        get: jest.fn(async (name) => boxes.get(name)!),
        stop: jest.fn(async () => {}),
        remove: jest.fn(async () => {}),
        deliverJit: jest.fn(async () => {
          delivered.resolve()
        }),
      },
      runners: jest.fn(async (guard) => ({
        registry: {
          create: jest.fn(async (name) => {
            await guard({ kind: 'register', name })
            return new JitRegistration({ id: 91, name }, 'c2VjcmV0')
          }),
          lookup: jest.fn(async () => null),
          remove: jest.fn(async () => {}),
        },
        close: jest.fn(async () => {}),
      })),
    }
    host = {
      discover: jest.fn(async (original, _signal, request) => {
        lease = { ...original }
        return { scopes: [scope], completed: request.wakes.map((row) => ({ ...row })), pending: false, ready: true }
      }),
      backend: jest.fn(async () => backend),
      accept: jest.fn((event) => inbox.receive(event)),
      report: jest.fn(),
    }
    listener = make()
  })
  afterEach(async () => {
    abort.abort()
    await db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const runUntil = async (event: Promise<void>) => {
    const task = listener.run(abort.signal),
      timeout = setTimeout(() => abort.abort(new Error('Listener test deadline')), 2000)
    try {
      await Promise.race([
        event,
        task.then(() => {
          throw new Error('Listener stopped before the expected event')
        }),
      ])
    } finally {
      abort.abort()
      clearTimeout(timeout)
      await task
    }
  }
  const ingressRows = () => state.recover(lease, 1000, ['notice/', 'wake/', 'receipt/'])
  it('persists a verified notification before any scheduler owns the lease and deduplicates a retry', async () => {
    const event = notification()
    expect(await listener.receive(event)).toBe('stored')
    expect(await listener.receive(event)).toBe('duplicate')
    const owner = (await state.acquire(randomUUID(), 3000))!
    expect((await state.recover(owner, 1000, ['notice/', 'receipt/'])).map((row) => row.key)).toEqual([
      'notice/1/55',
      'receipt/' + event.delivery,
    ])
    expect(host.backend).not.toHaveBeenCalled()
  })
  it('resolves a changed hosted quota on later cycles while zero capacity creates no Box', async () => {
    const observed: number[] = []
    const resolve = jest.fn(async () => {
      observed.push(jest.mocked(backend.workers.create).mock.calls.length)
      return testCapacity({ account: null, tenant: observed.length < 3 ? 0 : 1 })
    })
    listener = new Listener({
      state,
      host,
      worker: settings,
      capacity: { resolve: resolve },
      timing: { tickMs: 1, leaseMs: 3000 },
    })
    await listener.receive(notification())
    await runUntil(delivered.promise)
    expect(observed.slice(0, 3)).toEqual([0, 0, 0])
    expect(resolve.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
  })
  it('keeps the notice pending and issues no GitHub or Box requests when policy lookup fails', async () => {
    const observed = deferred()
    const resolve = jest.fn(async () => {
      throw Error('Capacity unavailable')
    })
    jest.mocked(host.report).mockImplementation(() => observed.resolve())
    listener = new Listener({
      state,
      host,
      worker: settings,
      capacity: { resolve },
      timing: { tickMs: 1, leaseMs: 3000 },
    })
    await listener.receive(notification())
    await runUntil(observed.promise)
    expect(resolve).toHaveBeenCalled()
    expect(backend.job).not.toHaveBeenCalled()
    expect(backend.workers.create).not.toHaveBeenCalled()
    expect((await ingressRows()).some((row) => row.key === 'notice/1/55')).toBe(true)
  })
  it('drives a durable queued notice through journaled Box boot and one JIT delivery', async () => {
    await listener.receive(notification())
    await runUntil(delivered.promise)
    const snapshot = await new ExecutionJournal(state).load(lease),
      allocation = [...snapshot.allocations.values()][0]
    expect(allocation.value).toMatchObject({
      delivery: 'done',
      box: { phase: 'known' },
      runner: { phase: 'known', id: 91 },
    })
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
    expect(backend.workers.deliverJit).toHaveBeenCalledTimes(1)
    expect(backend.close).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(snapshot.index)).not.toContain('c2VjcmV0')
    expect(host.report).not.toHaveBeenCalled()
  })
  it('creation refusal boundary: keeps the queued notice and logs the original rejected operation', async () => {
    const observed = deferred()
    const observe = jest.fn((event: { event: string }) => {
      if (event.event === 'ci-worker-create-rejected') observed.resolve()
    })
    Object.assign(host, { observe })
    jest.mocked(backend.workers.create).mockImplementationOnce(async (launch) => {
      const rows = await new ExecutionJournal(state).load(lease)
      const row = [...rows.allocations.values()].find((item) => item.value.name === launch.name)!
      throw new ConfirmedWorkerCreationRejected(row.value.effect!.id)
    })
    await listener.receive(notification())
    await runUntil(observed.promise)
    expect((await ingressRows()).some((row) => row.key === 'notice/1/55')).toBe(true)
    expect((await new ExecutionJournal(state).load(lease)).allocations.size).toBe(0)
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
    expect(backend.workers.deliverJit).not.toHaveBeenCalled()
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ci-worker-create-rejected',
        boxId: null,
        trigger: { repository: 21, run: 33, job: 55 },
      }),
    )
  })
  it('asks separately for repositories sharing a tenant and passes the exact job context', async () => {
    const other = structuredClone(scope)
    other.binding = 'second-repository'
    if (other.runners.kind !== 'repository') throw Error('Repository fixture required')
    other.runners.repository.id = 22
    const discover = jest.mocked(host.discover).getMockImplementation()!
    jest
      .mocked(host.discover)
      .mockImplementation(async (...args) => ({ ...(await discover(...args)), scopes: [scope, other] }))
    const resolve = jest.fn(async (request: CapacityRequest) => ({
      limits: [{ maximum: request.repository === 21 ? 0 : 1, includes: () => true }],
    }))
    listener = new Listener({
      state,
      host,
      worker: settings,
      capacity: { resolve },
      timing: { tickMs: 1, leaseMs: 3000 },
    })
    await listener.receive(notification(55, 1, 7, 21))
    await listener.receive(notification(56, 1, 7, 22))
    await runUntil(delivered.promise)
    expect(resolve.mock.calls.map(([request]) => request.repository)).toEqual(expect.arrayContaining([21, 22]))
    expect(resolve.mock.calls.find(([request]) => request.job?.job === 56)?.[0]).toMatchObject({
      scope: other,
      repository: 22,
      job: { repository: 22, run: 33, job: 56 },
      lease,
    })
    const snapshot = await new ExecutionJournal(state).load(lease)
    expect([...snapshot.allocations.values()].map((row) => row.value.job.repository)).toEqual([22])
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
  })
  it('compensates a missed webhook by recording the scanned job before dispatching it', async () => {
    jest
      .mocked(backend.queued)
      .mockResolvedValue([
        { repository: 21, run: 33, job: 55, status: 'queued', labels: ['boxlite-ci-runner'], runner: null },
      ])
    await runUntil(delivered.promise)
    expect((await ingressRows()).some((row) => row.key === 'notice/1/55')).toBe(true)
    expect(backend.queued).toHaveBeenCalledTimes(1)
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
  })
  it('settles a job which GitHub reports complete without creating capacity', async () => {
    await listener.receive(notification())
    jest.mocked(backend.job).mockImplementation(async (notice) => ({
      ...notice,
      status: 'completed',
      labels: ['boxlite-ci-runner'],
      runner: null,
    }))
    const scanned = deferred()
    jest.mocked(backend.queued).mockImplementation(async () => {
      scanned.resolve()
      return []
    })
    await runUntil(scanned.promise)
    expect((await ingressRows()).some((row) => row.key.startsWith('notice/'))).toBe(false)
    expect(backend.workers.create).not.toHaveBeenCalled()
  })
  it('retains a newer delivery when completion settlement uses an earlier notice version', async () => {
    await listener.receive(notification())
    const entered = deferred(),
      resume = deferred(),
      scanned = deferred()
    jest.mocked(backend.job).mockImplementation(async (notice) => {
      entered.resolve()
      await resume.promise
      return { ...notice, status: 'completed', labels: ['boxlite-ci-runner'], runner: null }
    })
    jest.mocked(backend.queued).mockImplementation(async () => {
      scanned.resolve()
      return []
    })
    const test = (async () => {
      await entered.promise
      await listener.receive(notification())
      resume.resolve()
    })()
    await runUntil(scanned.promise)
    await test
    expect((await ingressRows()).some((row) => row.key === 'notice/1/55')).toBe(true)
    expect(backend.workers.create).not.toHaveBeenCalled()
  })
  it('does not turn a notice for another installation into an authorized job', async () => {
    await listener.receive(notification(55, 9))
    const scanned = deferred()
    jest.mocked(backend.queued).mockImplementation(async () => {
      scanned.resolve()
      return []
    })
    await runUntil(scanned.promise)
    expect(backend.job).not.toHaveBeenCalled()
    expect(backend.workers.create).not.toHaveBeenCalled()
    expect((await ingressRows()).some((row) => row.key === 'notice/9/55')).toBe(true)
  })
  it('keeps notices pending after an incomplete directory refresh', async () => {
    await listener.receive(notification())
    const failed = deferred()
    jest.mocked(host.discover).mockImplementation(async (original) => {
      lease = original
      throw new Error('Incomplete directory')
    })
    jest.mocked(host.report).mockImplementation(() => failed.resolve())
    await runUntil(failed.promise)
    expect((await ingressRows()).some((row) => row.key === 'notice/1/55')).toBe(true)
    expect(host.backend).not.toHaveBeenCalled()
  })
  it('blocks admission on a missing historical allocation before reading current bindings', async () => {
    const journal = new ExecutionJournal(state)
    await journal.initialize()
    const original = (await state.acquire('old-owner', 3000))!,
      key = await journal.define(original, scope)
    const allocation = (await journal.reserve(
      original,
      key,
      { repository: 21, run: 33, job: 55 },
      testCapacity({ account: 1, tenant: 2 }),
    ))!
    await state.commit(original, [{ key: allocation.record.key, expected: allocation.record.version }])
    await db.transaction(namespace, async (tx) => {
      const row = (await tx.get('@owner', true))!
      await tx.put({ ...row, version: randomUUID(), payload: { ...(row.payload as object), until: 0 } }, row.version)
    })
    const failed = deferred()
    jest.mocked(host.report).mockImplementation(() => failed.resolve())
    await runUntil(failed.promise)
    expect(host.discover).not.toHaveBeenCalled()
    expect(host.backend).not.toHaveBeenCalled()
  })
  it('admits known work while App delivery recovery is still waiting for HTTP', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetcher = jest.spyOn(global, 'fetch').mockImplementation(async () => {
      await gate
      return new Response('[]')
    })
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    const app = new GitHubAppSource({ issuer: 'test-app', privateKey: () => key })
    const recovery = new AppDeliveryRecovery({
      state,
      app: () => app,
      authorize: async (current) => {
        await new ExecutionJournal(state).load(current)
        return true
      },
      report: () => {},
    })
    Object.assign(host, { recovery })
    try {
      await listener.receive(notification(55))
      await runUntil(delivered.promise)
      expect(fetcher).toHaveBeenCalled()
      expect(backend.workers.create).toHaveBeenCalledTimes(1)
    } finally {
      release()
      await recovery.close()
      fetcher.mockRestore()
    }
  })
  it('keeps queued jobs pending without repeated GitHub reads while account capacity is occupied', async () => {
    await listener.receive(notification(55))
    await listener.receive(notification(56))
    const observed = deferred(),
      recover = state.recover.bind(state)
    let ticks = 0
    jest.spyOn(state, 'recover').mockImplementation(async (owner, maximum, prefixes) => {
      const rows = await recover(owner, maximum, prefixes)
      if (prefixes?.includes('notice/') && ++ticks === 4) observed.resolve()
      return rows
    })
    await runUntil(observed.promise)
    expect((await new ExecutionJournal(state).load(lease)).allocations.size).toBe(1)
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
    expect((await ingressRows()).some((row) => row.key === 'notice/1/56')).toBe(true)
    expect(jest.mocked(backend.job).mock.calls.map(([notice]) => notice.job)).not.toContain(56)
    expect(backend.job).toHaveBeenCalledTimes(2)
    expect(backend.queued).not.toHaveBeenCalled()
  })
  it.each([
    ['tenant', false],
    ['another-tenant', true],
  ] as const)(
    'demand scheduling respects occupied tenant capacity and preserves other tenants: %s',
    async (tenant, available) => {
      const other = structuredClone(scope)
      other.binding = 'other'
      other.organization = tenant
      other.installation = { id: 2, account: { id: 8, login: 'other', type: 'User' } }
      other.runners = {
        kind: 'repository',
        repository: {
          id: 22,
          owner: { id: 8, login: 'other' },
          name: 'repo',
          private: true,
        },
        allowPublic: false,
      }
      const journal = new ExecutionJournal(state)
      await journal.initialize()
      const previous = (await state.acquire('previous-owner', 3000))!
      const key = await journal.define(previous, scope)
      await journal.reserve(
        previous,
        key,
        { repository: 21, run: 33, job: 55 },
        testCapacity({ account: 2, tenant: 1 }),
      )
      await db.transaction(namespace, async (tx) => {
        const row = (await tx.get('@owner', true))!
        await tx.put({ ...row, version: randomUUID(), payload: { ...(row.payload as object), until: 0 } }, row.version)
      })
      jest.mocked(backend.workers.create).mockRejectedValue(new Error('Creation outcome pending'))
      jest.mocked(backend.workers.get).mockRejectedValue(new Error('Original Box ID not observed'))
      jest.mocked(host.discover).mockImplementation(async (owner, _signal, request) => {
        lease = owner
        return {
          scopes: [scope, other],
          completed: request.wakes.map((row) => ({ ...row })),
          ready: true,
          pending: false,
        }
      })
      const observed = deferred(),
        recover = state.recover.bind(state)
      let ticks = 0
      jest.spyOn(state, 'recover').mockImplementation(async (owner, maximum, prefixes) => {
        const rows = await recover(owner, maximum, prefixes)
        if (prefixes?.includes('notice/') && ++ticks === 4) observed.resolve()
        return rows
      })
      listener = new Listener({
        state,
        host,
        worker: settings,
        capacity: { resolve: async () => testCapacity({ account: 2, tenant: 1 }) },
        timing: { tickMs: 1, leaseMs: 3000 },
      })
      await runUntil(observed.promise)
      expect(jest.mocked(backend.queued).mock.calls.map(([repository]) => repository)).toEqual(available ? [22] : [])
      expect(
        (await journal.load(lease)).workers.filter((worker) => worker.organization === scope.organization),
      ).toHaveLength(1)
    },
  )
  it('continues another account after recovery of the first account fails', async () => {
    const other = structuredClone(scope)
    other.binding = 'other'
    other.installation = { id: 2, account: { id: 8, login: 'other', type: 'User' } }
    other.runners = {
      kind: 'repository',
      repository: { id: 22, owner: { id: 8, login: 'other' }, name: 'repo', private: true },
      allowPublic: false,
    }
    const journal = new ExecutionJournal(state)
    await journal.initialize()
    const original = (await state.acquire('old-owner', 3000))!,
      key = await journal.define(original, scope)
    await journal.reserve(original, key, { repository: 21, run: 33, job: 55 }, testCapacity({ account: 1, tenant: 2 }))
    await db.transaction(namespace, async (tx) => {
      const row = (await tx.get('@owner', true))!
      await tx.put({ ...row, version: randomUUID(), payload: { ...(row.payload as object), until: 0 } }, row.version)
    })
    await listener.receive(notification(56, 2, 8, 22))
    const failedBackend = {
      ...backend,
      workers: {
        ...backend.workers,
        create: jest.fn(async () => {
          throw new Error('First account unavailable')
        }),
      },
    }
    jest.mocked(host.discover).mockImplementation(async (original, _signal, request) => {
      lease = original
      return {
        scopes: [scope, other],
        completed: request.wakes.map((row) => ({ ...row })),
        pending: false,
        ready: true,
      }
    })
    jest
      .mocked(host.backend)
      .mockImplementation(async (original) => (original.installation.id === 1 ? failedBackend : backend))
    await runUntil(delivered.promise)
    expect(failedBackend.workers.create).toHaveBeenCalledTimes(1)
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
    expect((await new ExecutionJournal(state).load(lease)).allocations.size).toBe(2)
  })
  it('retains failed shutdown handles and refuses another session before retiring them', async () => {
    await listener.receive(notification())
    jest.mocked(backend.close).mockRejectedValue(new Error('Retirement pending'))
    await expect(runUntil(delivered.promise)).rejects.toThrow('retirement is incomplete')
    const next = new AbortController(),
      reported = deferred()
    jest.mocked(host.report).mockImplementation(() => {
      reported.resolve()
      next.abort()
    })
    await listener.run(next.signal)
    await reported.promise
    expect(host.backend).toHaveBeenCalledTimes(1)
    expect(backend.close).toHaveBeenCalledTimes(2)
    jest.mocked(backend.close).mockResolvedValue()
  })
  it('renews ownership while a GitHub operation is waiting beyond the original lease expiry', async () => {
    listener = new Listener({
      state,
      host,
      worker: settings,
      capacity: { resolve: async () => testCapacity({ account: 1, tenant: 2 }) },
      timing: { tickMs: 1, leaseMs: 300 },
    })
    await listener.receive(notification())
    const entered = deferred(),
      resume = deferred(),
      read = backend.job.bind(backend),
      renew = jest.spyOn(state, 'renew')
    jest.mocked(backend.job).mockImplementationOnce(async (notice, signal) => {
      entered.resolve()
      await resume.promise
      return read(notice, signal)
    })
    const probing = (async () => {
      await entered.promise
      await new Promise<void>((resolve) => setTimeout(resolve, 650))
      try {
        expect(renew.mock.calls.length).toBeGreaterThanOrEqual(2)
        expect(await state.acquire('another-process', 300)).toBeUndefined()
      } finally {
        resume.resolve()
      }
    })()
    await runUntil(delivered.promise)
    await probing
    expect(host.report).not.toHaveBeenCalled()
  })
  it('does not scan idle repositories or refresh the directory on every scheduler tick', async () => {
    const observed = deferred(),
      recover = state.recover.bind(state)
    let ticks = 0
    jest.spyOn(state, 'recover').mockImplementation(async (owner, maximum, prefixes) => {
      const rows = await recover(owner, maximum, prefixes)
      if (prefixes?.includes('notice/') && ++ticks === 3) observed.resolve()
      return rows
    })
    await runUntil(observed.promise)
    expect(host.discover).toHaveBeenCalledTimes(1)
    expect(backend.queued).toHaveBeenCalledTimes(1)
    expect(backend.workers.create).not.toHaveBeenCalled()
  })
  it('refuses an overlapping run call while keeping the first execution owner', async () => {
    const entered = deferred(),
      resume = deferred(),
      discover = host.discover.bind(host)
    jest.mocked(host.discover).mockImplementationOnce(async (owner, signal, request) => {
      entered.resolve()
      await resume.promise
      return discover(owner, signal, request)
    })
    const task = listener.run(abort.signal)
    try {
      await entered.promise
      await expect(listener.run(abort.signal)).rejects.toThrow('already running')
    } finally {
      abort.abort()
      resume.resolve()
      await task
    }
    expect(backend.workers.create).not.toHaveBeenCalled()
  })
  it('forwards persisted recovery facts from the actual pool to its host', async () => {
    const finished = deferred(),
      events: unknown[] = []
    let delivered = false,
      removed = false
    const get = jest.mocked(backend.workers.get).getMockImplementation()!
    jest.mocked(backend.workers.get).mockImplementation(async (name) => {
      if (removed) throw new ConfirmedWorkerAbsent()
      const box = await get(name)
      return delivered ? { ...box, status: 'error', exit_code: 137 } : box
    })
    jest.mocked(backend.workers.deliverJit).mockImplementation(async () => {
      delivered = true
    })
    jest.mocked(backend.workers.remove).mockImplementation(async () => {
      removed = true
    })
    Object.assign(host, {
      observe: (event: { event: string }) => {
        events.push(event)
        if (event.event === 'ci-worker-released') finished.resolve()
      },
    })
    await listener.receive(notification())
    await runUntil(finished.promise)
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'ci-worker-exited',
        status: 'error',
        exitCode: 137,
        level: 'warn',
        trigger: { repository: 21, run: 33, job: 55 },
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'ci-worker-released', boxPhase: 'absent', runnerPhase: 'absent' }),
    )
    expect((await new ExecutionJournal(state).load(lease)).allocations.size).toBe(0)
  })
})
