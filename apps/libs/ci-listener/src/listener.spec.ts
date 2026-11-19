/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { inspectJournal } from '../tests/journal'
import { testCapacity } from '../tests/capacity'
import { createHmac, generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionJournal } from './execution/journal'
import { ExecutionScope, decodeAllocation, decodeScope, scopeKey } from './execution/model'
import { Listener, ListenerBackend, ListenerHost } from './listener'
import { NotifiedDemand } from './notified-demand'
import * as demandState from './demand'
import { JitRegistration } from './runners'
import { WorkerPool } from './execution/pool'
import { WorkQueue } from './execution/work-queue'
import { SqliteStateDatabase } from './state/sqlite'
import { ExecutionLease, ListenerState } from './state/store'
import { ListenerInbox, verifyWebhook } from './webhook'
import { AppDeliveryRecovery } from './replay/recovery'
import { GitHubAppSource } from './github-app'
import { ConfirmedWorkerAbsent, ConfirmedWorkerCreationRejected } from './worker'
import { StateConflict, StateCorrupt } from './state/database'
import { CapacityRequest } from './capacity'
import { ScanClaim } from './compensation/queue'
import { WorkflowJob } from './jobs'

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
    abort: AbortController,
    publishScan: jest.Mock<Promise<void>, [ScanClaim, readonly WorkflowJob[]]>
  const settings = { image: 'runner-test', cpus: 2, memoryMiB: 2048, labels: ['boxlite'] }
  const notification = (job = 55, installation = 1, account = 7, repository = 21, run = 33, labels = ['boxlite']) => {
    const secret = Buffer.alloc(32, 1),
      raw = Buffer.from(
        JSON.stringify({
          action: 'queued',
          installation: { id: installation },
          repository: { id: repository, owner: { id: account } },
          workflow_job: { id: job, run_id: run, status: 'queued', labels },
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
  const withScanCatalog = (original: ListenerHost): ListenerHost => {
    const wrapped = Object.create(original) as ListenerHost
    wrapped.discover = async (...args) => {
      const result = await original.discover(...args)
      const valid = result.scopes.flatMap((scope) => {
        try {
          return [decodeScope(scope)]
        } catch {
          return []
        }
      })
      const bindings = new Set(valid.map((scope) => scope.binding))
      for (const binding of bindings)
        await state.scans().synchronize(
          args[0],
          'fixture',
          binding,
          valid.filter((scope) => scope.binding === binding),
        )
      return result
    }
    return wrapped
  }
  const make = () =>
    new Listener({
      state,
      host: withScanCatalog(host),
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
        allowPrivate: true,
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
        labels: ['boxlite'],
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
    publishScan = jest.fn((claim, jobs) => state.scans().publish(claim, jobs, settings.labels))
    host = {
      scan: jest.fn(async (claim: ScanClaim) => ({
        queued: (signal: AbortSignal) => backend.queued(claim.repository, signal),
        publish: (jobs: readonly WorkflowJob[]) => publishScan(claim, jobs),
        close: async () => {},
      })),
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
  const runUntil = async (event: Promise<void>, deadline = 2000) => {
    const task = listener.run(abort.signal),
      timeout = setTimeout(() => abort.abort(new Error('Listener test deadline')), deadline)
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
  it.each([3, 5])('coordinates slow repository scans and defers an expired cohort: %s repositories', async (count) => {
    const repos = Array.from({ length: count }, (_, index) => index + 21)
    scope = {
      ...scope,
      installation: { id: 1, account: { id: 7, login: 'owner', type: 'Organization' } },
      runners: {
        kind: 'organization',
        account: { id: 7, login: 'owner' },
        group: 5,
        repositories: repos,
        allowPrivate: true,
        allowPublic: false,
      },
    }
    const journal = new ExecutionJournal(state)
    await journal.initialize()
    const original = (await state.acquire('former-owner', 300000))!
    const key = await journal.define(original, scope)
    const pool = new WorkerPool(
      journal,
      key,
      async () => backend,
      settings,
      () => {},
    )
    await pool.tick(original, testCapacity({ account: 1, tenant: 1 }), { repository: 21, run: 33, job: 55 })
    await pool.close()
    const [row] = (await journal.workers(original, key)).rows
    await journal.advance(original, row.record.key, row.record.version, {
      runner: { ...row.value.runner, registeredAt: Date.now() - 301000 },
    })
    await db.transaction(namespace, async (tx) => {
      const expiry = (await tx.get('@lease', true))!
      await tx.put({ ...expiry, version: randomUUID(), payload: { until: 0 } }, expiry.version)
    })
    const started = new Set<number>(),
      allStarted = deferred(),
      held = deferred(),
      lastStarted = deferred(),
      lastHeld = deferred(),
      retired = deferred(),
      deferredRetirement = deferred()
    jest.mocked(host.report).mockImplementation((_error, operation) => {
      if (operation === 'surplus-retirement-deferred') deferredRetirement.resolve()
    })
    Object.assign(backend, {
      inventory: async () => [{ id: 91, name: row.value.name, status: 'online', busy: false, labels: ['boxlite'] }],
    })
    jest.mocked(backend.queued).mockImplementation(async (repository) => {
      started.add(repository)
      if (started.size === Math.min(4, count)) allStarted.resolve()
      if (repository === 25) {
        lastStarted.resolve()
        await lastHeld.promise
      } else await held.promise
      return []
    })
    const open = jest.mocked(backend.runners).getMockImplementation()!
    jest.mocked(backend.runners).mockImplementation(async (...args) => {
      const session = await open(...args)
      session.registry.retireIdle = async (identity) => {
        await args[0]({ kind: 'remove', ...identity })
        retired.resolve()
        return false
      }
      return session
    })
    jest.mocked(host.scan).mockResolvedValue({ queued: async () => [], publish: async () => {}, close: async () => {} })
    let now = Date.now()
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now)
    listener = new Listener({
      state,
      host: withScanCatalog(host),
      worker: settings,
      capacity: { resolve: async () => testCapacity({ account: 1, tenant: 1 }) },
      timing: { tickMs: 1, leaseMs: 300000 },
    })
    const running = listener.run(abort.signal)
    let decisionTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([allStarted.promise, new Promise((resolve) => setTimeout(resolve, 250))])
      expect(started).toEqual(new Set(repos.slice(0, 4)))
      now += 35000
      held.resolve()
      if (count === 5) {
        await lastStarted.promise
        now += 35000
        lastHeld.resolve()
      }
      await Promise.race([
        count === 3 ? retired.promise : deferredRetirement.promise,
        new Promise((_, reject) => {
          decisionTimer = setTimeout(() => reject(new Error('No retirement decision')), 2000)
        }),
      ])
      expect(started).toEqual(new Set(repos))
      expect(backend.workers.stop).not.toHaveBeenCalled()
      if (count === 5) {
        expect(jest.mocked(backend.queued).mock.calls).toHaveLength(5)
        expect(host.report).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'ScopeProofFreshnessExceeded' }),
          'surplus-retirement-deferred',
        )
      }
    } finally {
      held.resolve()
      lastHeld.resolve()
      clearTimeout(decisionTimer)
      abort.abort()
      await running
      clock.mockRestore()
    }
  })
  it('keeps stopped-resource recovery available after 101 repository snapshots complete', async () => {
    const repos = Array.from({ length: 101 }, (_, index) => 21 + index)
    scope = {
      ...scope,
      installation: { id: 1, account: { id: 7, login: 'owner', type: 'Organization' } },
      runners: {
        kind: 'organization',
        account: { id: 7, login: 'owner' },
        group: 5,
        repositories: repos,
        allowPrivate: true,
        allowPublic: false,
      },
    }
    const completed = new Set<number>(),
      recovered = deferred(),
      invalidLookup = deferred()
    jest.mocked(host.report).mockImplementation((error) => {
      if (error instanceof Error && error.message === 'Invalid Listener lookup keys') invalidLookup.resolve()
    })
    let name = '',
      completeInventories = 0,
      stopped = false,
      removed = false
    const get = jest.mocked(backend.workers.get).getMockImplementation()!
    jest.mocked(backend.workers.get).mockImplementation(async (name) => {
      if (removed) throw new ConfirmedWorkerAbsent()
      return { ...(await get(name)), status: stopped ? 'stopped' : 'running' }
    })
    jest.mocked(backend.workers.remove).mockImplementation(async () => {
      removed = true
    })
    jest.mocked(backend.workers.deliverJit).mockImplementation(async (worker) => {
      name = worker
      delivered.resolve()
    })
    Object.assign(backend, {
      inventory: async () => {
        if (completed.size === repos.length && ++completeInventories >= 2) stopped = true
        return name ? [{ id: 91, name, status: 'online', busy: false, labels: ['boxlite'] }] : []
      },
      reader: () => {
        let repository: number | undefined
        return {
          queued: async (id: number) => {
            repository = id
            await delivered.promise
            return id === 21
              ? [{ repository: 21, run: 33, job: 55, status: 'queued', runner: null, labels: ['boxlite'] }]
              : []
          },
          close: async () => {
            if (repository !== undefined) completed.add(repository)
          },
        }
      },
    })
    host.observe = (event) => {
      if (event.event === 'ci-worker-released') recovered.resolve()
    }
    jest.mocked(host.scan).mockResolvedValue({ queued: async () => [], publish: async () => {}, close: async () => {} })
    listener = new Listener({
      state,
      host: withScanCatalog(host),
      worker: settings,
      capacity: { resolve: async () => testCapacity({ account: 1, tenant: 1 }) },
      timing: { tickMs: 1, leaseMs: 30000 },
    })
    await listener.receive(notification())
    await runUntil(
      Promise.race([
        recovered.promise,
        invalidLookup.promise.then(() => {
          expect(completed.size).toBe(101)
          throw new Error('101 repository proofs blocked stopped-resource recovery: Invalid Listener lookup keys')
        }),
      ]),
      10000,
    )
    expect(completed.size).toBe(101)
    expect(stopped).toBe(true)
    expect(backend.workers.remove).toHaveBeenCalled()
  }, 15000)
  it('retires a failed verification reader before opening its replacement', async () => {
    const reopened = deferred(),
      trace: string[] = []
    let reads = 0,
      closeFailed = false
    Object.assign(backend, {
      inventory: jest.fn(async () => []),
      reader: () => {
        let verification = false,
          first = false
        return {
          queued: backend.queued,
          pending: async (notices: readonly { repository: number; run: number; job: number }[]) => {
            verification = true
            first = ++reads === 1
            trace.push('verify-' + reads)
            if (reads === 2) reopened.resolve()
            return notices.map((notice) => ({
              ...notice,
              status: 'queued' as const,
              runner: null,
              labels: ['boxlite'],
            }))
          },
          close: async () => {
            if (!verification || !first) return
            if (!closeFailed) {
              closeFailed = true
              trace.push('close-failed')
              throw new Error('Token retirement pending')
            }
            trace.push('close-succeeded')
          },
        }
      },
    })
    jest.mocked(host.scan).mockResolvedValue({ queued: async () => [], publish: async () => {}, close: async () => {} })
    jest
      .mocked(backend.queued)
      .mockResolvedValue([{ repository: 21, run: 33, job: 55, status: 'queued', runner: null, labels: ['boxlite'] }])
    await listener.receive(notification())
    await runUntil(reopened.promise)
    expect(trace.indexOf('close-succeeded')).toBeGreaterThan(trace.indexOf('close-failed'))
    expect(trace.indexOf('verify-2')).toBeGreaterThan(trace.indexOf('close-succeeded'))
  })
  it('verifies another run in the same scope while the first run job lookup is pending', async () => {
    Object.assign(backend, { inventory: jest.fn(async () => []) })
    jest.mocked(host.scan).mockResolvedValue({ queued: async () => [], publish: async () => {}, close: async () => {} })
    const untilAbort = (signal?: AbortSignal) =>
      new Promise<void>((resolve) => {
        if (signal?.aborted) resolve()
        else signal?.addEventListener('abort', () => resolve(), { once: true })
      })
    jest.mocked(backend.queued).mockImplementation(async (_repository, signal) => {
      await untilAbort(signal)
      return []
    })
    jest.mocked(backend.job).mockImplementation(async (notice, signal) => {
      if (notice.run === 33) {
        await untilAbort(signal)
        signal?.throwIfAborted()
      }
      return { ...notice, status: 'queued', runner: null, labels: ['boxlite'] }
    })
    const created = deferred(),
      create = jest.mocked(backend.workers.create).getMockImplementation()!
    let count = 0
    jest.mocked(backend.workers.create).mockImplementation(async (launch) => {
      const box = await create(launch)
      if (++count === 16) created.resolve()
      return box
    })
    listener = new Listener({
      state,
      host: withScanCatalog(host),
      worker: settings,
      capacity: { resolve: async () => testCapacity({ account: 16, tenant: 16 }) },
      timing: { tickMs: 1, leaseMs: 3000 },
    })
    for (let id = 55; id < 71; id++) await listener.receive(notification(id))
    for (let id = 71; id < 87; id++) await listener.receive(notification(id, 1, 7, 21, 34))
    const running = listener.run(abort.signal)
    try {
      await Promise.race([created.promise, new Promise((resolve) => setTimeout(resolve, 1000))])
      expect(backend.workers.create).toHaveBeenCalledTimes(16)
      const rows = [...(await inspectJournal(state, lease)).allocations.values()]
      expect(rows).toHaveLength(16)
      expect(rows.every((row) => row.value.job!.run === 34)).toBe(true)
    } finally {
      abort.abort()
      await running
    }
  })
  it('accumulates 64 notified jobs across verification turns while enumeration is blocked', async () => {
    const created = deferred()
    Object.assign(backend, { inventory: jest.fn(async () => []) })
    jest.mocked(host.scan).mockResolvedValue({ queued: async () => [], publish: async () => {}, close: async () => {} })
    jest.mocked(backend.queued).mockImplementation(async (_repository, signal) => {
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve()
        else signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      return []
    })
    const create = backend.workers.create
    let count = 0
    jest.mocked(create).mockImplementation(async () => {
      if (++count === 64) created.resolve()
      return { box_id: randomUUID(), status: 'running' }
    })
    listener = new Listener({
      state,
      host: withScanCatalog(host),
      worker: settings,
      capacity: { resolve: async () => testCapacity({ account: 64, tenant: 64 }) },
      timing: { tickMs: 1, leaseMs: 3000 },
    })
    for (let id = 55; id < 119; id++) {
      await listener.receive(notification(id, 1, 7, 21, id + 1000))
    }
    await runUntil(created.promise)
    expect(create).toHaveBeenCalledTimes(64)
    // The listener has stopped renewing; post-shutdown assertions must tolerate expiry.
    await db.transaction(namespace, async (tx) => {
      const expiry = (await tx.get('@lease', true))!
      await tx.put({ ...expiry, version: randomUUID(), payload: { until: 0 } }, expiry.version)
    })
    const allocations = await db.transaction(namespace, async (tx) =>
      (await tx.page('', 65, 'worker/')).map((row) => decodeAllocation(row.payload)),
    )
    expect(allocations).toHaveLength(64)
    expect(new Set(allocations.map((row) => row.name)).size).toBe(64)
  })
  it('reuses each of 64 same-run notice verifications across twelve scheduler pumps', async () => {
    const pumped = deferred()
    Object.assign(backend, {
      inventory: jest.fn(async () => []),
      pending: jest.fn(async (notices: readonly { repository: number; run: number; job: number }[]) =>
        notices.map((notice) => ({ ...notice, status: 'queued' as const, runner: null, labels: ['boxlite'] })),
      ),
    })
    jest.mocked(backend.queued).mockRejectedValue(new Error('enumeration unavailable'))
    jest.mocked(host.scan).mockResolvedValue({ queued: async () => [], publish: async () => {}, close: async () => {} })
    let pumps = 0
    const recover = state.recover.bind(state)
    jest.spyOn(state, 'recover').mockImplementation(async (...args) => {
      const rows = await recover(...args)
      if (args[2]?.includes('notice/') && ++pumps === 12) pumped.resolve()
      return rows
    })
    listener = new Listener({
      state,
      host: withScanCatalog(host),
      worker: settings,
      capacity: { resolve: async () => testCapacity({ account: 0, tenant: 0 }) },
      timing: { tickMs: 1, leaseMs: 3000 },
    })
    for (let id = 55; id < 119; id++) await listener.receive(notification(id))
    await runUntil(pumped.promise)
    const requests = jest.mocked(backend.pending!).mock.calls.map(([notices]) => notices)
    expect(new Set(requests.flat().map((notice) => notice.job)).size).toBe(64)
    expect(requests.every((notices) => notices.length <= 32)).toBe(true)
    expect(requests).toHaveLength(2)
    expect(backend.workers.create).not.toHaveBeenCalled()
  })
  it('discards a delayed scope scan after observing a newly busy runner', async () => {
    const journal = new ExecutionJournal(state)
    await journal.initialize()
    const owner = (await state.acquire('initial-owner', 300000))!
    const key = await journal.define(owner, scope)
    const pool = new WorkerPool(journal, key, async () => backend, settings)
    const notice = { repository: 21, run: 33, job: 55 }
    await pool.tick(owner, testCapacity({ account: 2, tenant: 2 }), notice)
    await pool.close()
    const [worker] = (await journal.workers(owner, key)).rows
    await db.transaction(namespace, async (tx) => {
      const expiry = (await tx.get('@lease', true))!
      await tx.put({ ...expiry, version: randomUUID(), payload: { until: 0 } }, expiry.version)
    })
    const invalidation = deferred(),
      settled = deferred()
    const job: WorkflowJob = { ...notice, status: 'queued', runner: null, labels: ['boxlite'] }
    let captured = false,
      busy = false,
      pumps = 0
    const corrections = jest.spyOn(demandState, 'rebuildQueueSnapshot')
    const previous = NotifiedDemand.prototype.invalidate
    const invalidate = jest.spyOn(NotifiedDemand.prototype, 'invalidate').mockImplementation(async function (
      this: NotifiedDemand,
      ...args: Parameters<typeof previous>
    ) {
      const value = await previous.apply(this, args)
      if (!args[2] && captured) {
        busy = true
        invalidation.resolve()
      }
      return value
    })
    Object.assign(backend, {
      inventory: async () => [
        { id: 91, name: worker.value.name, status: 'online', busy: captured, labels: ['boxlite'] },
      ],
    })
    jest.mocked(host.scan).mockResolvedValue({ queued: async () => [], publish: async () => {}, close: async () => {} })
    jest.mocked(backend.job).mockImplementation(async () => {
      if (busy) throw new Error('Assignment details unavailable')
      return job
    })
    jest.mocked(backend.queued).mockImplementation(async (_repository, signal) => {
      if (captured) return []
      captured = true
      signal?.addEventListener('abort', invalidation.resolve, { once: true })
      await invalidation.promise
      signal?.removeEventListener('abort', invalidation.resolve)
      signal?.throwIfAborted()
      return [job]
    })
    const recover = state.recover.bind(state)
    jest.spyOn(state, 'recover').mockImplementation(async (...args) => {
      const result = await recover(...args)
      if (args[2]?.includes('notice/') && busy && ++pumps >= 10) settled.resolve()
      return result
    })
    listener = new Listener({
      state,
      host: withScanCatalog(host),
      worker: settings,
      capacity: { resolve: async () => testCapacity({ account: 2, tenant: 2 }) },
      timing: { tickMs: 2, leaseMs: 3000 },
    })
    try {
      await listener.receive(notification())
      await state.ingress('1/21', async (tx) => {
        const [wake] = await tx.read(['wake/1/21'])
        await tx.write([{ key: wake.key, expected: wake.version }])
      })
      await runUntil(settled.promise)
      expect(busy).toBe(true)
      const stale = corrections.mock.calls.flatMap((args, index) =>
        args[4].some((observed) => observed.job === job.job) ? [corrections.mock.results[index].value] : [],
      )
      const results = await Promise.allSettled(stale)
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(0)
      expect(backend.workers.create).toHaveBeenCalledTimes(1)
    } finally {
      invalidation.resolve()
      invalidate.mockRestore()
      corrections.mockRestore()
    }
  })
  it.each(['dirty', 'mismatch'])('plans from targeted job verification during a failed scan: %s', async (mode) => {
    const held = deferred(),
      pumped = deferred()
    const labels = mode === 'dirty' ? ['boxlite'] : ['boxlite', 'gpu']
    Object.assign(backend, { inventory: async () => [] })
    jest.mocked(host.scan).mockResolvedValue({ queued: async () => [], publish: async () => {}, close: async () => {} })
    jest.mocked(backend.queued).mockRejectedValue(new Error('Full scan unavailable'))
    jest.mocked(backend.job).mockImplementation(async (notice) => {
      await held.promise
      return { ...notice, status: 'queued', runner: null, labels }
    })
    await listener.receive(notification(55, 1, 7, 21, 33, labels))
    await state.ingress('1/21', async (tx) => {
      const [wake] = await tx.read(['wake/1/21'])
      await tx.write([{ key: wake.key, expected: wake.version }])
    })
    if (mode === 'dirty') {
      await db.transaction(namespace, async (tx) => {
        const [counter] = await tx.page('', 1, 'demand/')
        await tx.put(
          { ...counter, version: randomUUID(), payload: { ...(counter.payload as object), dirty: true } },
          counter.version,
        )
      })
    }
    const recover = state.recover.bind(state)
    let rounds = 0
    jest.spyOn(state, 'recover').mockImplementation(async (...args) => {
      const rows = await recover(...args)
      if (args[2]?.includes('notice/')) {
        if (++rounds === 4) held.resolve()
        if (rounds === 15) pumped.resolve()
      }
      return rows
    })
    try {
      await runUntil(pumped.promise)
      expect(backend.workers.create).toHaveBeenCalledTimes(mode === 'dirty' ? 1 : 0)
      expect(backend.job).toHaveBeenCalledTimes(1)
    } finally {
      held.resolve()
    }
  })
  it.each(['expiry', 'notice version', 'scope'])(
    'rechecks a cached label mismatch after a change of %s',
    async (change) => {
      const checked = deferred(),
        stable = deferred()
      const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now())
      const labels = ['boxlite', 'gpu']
      let changed = false,
        rounds = 0,
        readsBefore = 0
      Object.assign(backend, { inventory: async () => [] })
      jest
        .mocked(host.scan)
        .mockResolvedValue({ queued: async () => [], publish: async () => {}, close: async () => {} })
      jest.mocked(backend.queued).mockRejectedValue(new Error('Full scan unavailable'))
      jest.mocked(backend.job).mockImplementation(async (notice) => {
        if (changed) checked.resolve()
        return { ...notice, status: 'queued', runner: null, labels }
      })
      listener = new Listener({
        state,
        host: withScanCatalog(host),
        worker: settings,
        capacity: { resolve: async () => testCapacity({ account: 1, tenant: 1 }) },
        timing: { tickMs: 1, discoveryMs: 1, leaseMs: 300000 },
      })
      const recover = state.recover.bind(state)
      jest.spyOn(state, 'recover').mockImplementation(async (...args) => {
        const result = await recover(...args)
        if (args[2]?.includes('notice/') && ++rounds === 12) {
          readsBefore = jest.mocked(backend.job).mock.calls.length
          stable.resolve()
        }
        return result
      })
      try {
        await listener.receive(notification(55, 1, 7, 21, 33, labels))
        const changeSelection = async () => {
          await stable.promise
          changed = true
          if (change === 'expiry') clock.mockReturnValue(Date.now() + 30001)
          else if (change === 'notice version') {
            const [notice] = await state.read(['notice/1/55'])
            await state.commit(lease, [{ key: notice.key, expected: notice.version, payload: notice.payload }])
          } else {
            scope = { ...scope, generation: scope.generation + 1 }
            clock.mockReturnValue(Date.now() + 2)
          }
          await checked.promise
        }
        await runUntil(changeSelection())
        expect(readsBefore).toBe(1)
        expect(backend.job).toHaveBeenCalledTimes(2)
        expect(backend.workers.create).not.toHaveBeenCalled()
        expect(await state.read(['notice/1/55'])).toHaveLength(1)
      } finally {
        clock.mockRestore()
      }
    },
  )
  it('does not grant positive capacity from stale queued HTTP data after recorded completion', async () => {
    const checked = deferred()
    Object.assign(backend, { inventory: jest.fn(async () => []) })
    jest.mocked(backend.queued).mockRejectedValue(new Error('Background scan unavailable'))
    listener = new Listener({
      state,
      host: withScanCatalog(host),
      worker: settings,
      capacity: { resolve: async () => testCapacity({ account: 2, tenant: 2 }) },
      timing: { tickMs: 1, leaseMs: 3000 },
    })
    await listener.receive(notification())
    await listener.receive(observePhase('completed', 55))
    const { observation: _observation, ...replayed } = notification()
    await listener.receive(replayed)
    await listener.receive(notification(56))
    const balance = WorkerPool.prototype.balance
    const balanced = jest.spyOn(WorkerPool.prototype, 'balance').mockImplementation(async function (
      this: WorkerPool,
      ...args
    ) {
      await balance.apply(this, args)
      if (String(args[4]) === 'positive' && (await inspectJournal(state, lease)).allocations.size) checked.resolve()
    })
    try {
      await runUntil(Promise.all([checked.promise, delivered.promise]).then(() => {}))
      const rows = [...(await inspectJournal(state, lease)).allocations.values()]
      expect(rows).toHaveLength(1)
      expect(rows[0].value.job!.job).toBe(56)
      expect(backend.job).toHaveBeenCalledWith({ repository: 21, run: 33, job: 55 }, expect.any(AbortSignal))
    } finally {
      balanced.mockRestore()
    }
  })
  it('admits a notified job while complete repository enumeration is blocked', async () => {
    Object.assign(backend, { inventory: jest.fn(async () => []) })
    jest.mocked(host.scan).mockResolvedValue({ queued: async () => [], publish: async () => {}, close: async () => {} })
    jest.mocked(backend.queued).mockImplementation(async (_repository, signal) => {
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve()
        else signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      return []
    })
    await listener.receive(notification())
    const task = listener.run(abort.signal)
    try {
      await Promise.race([delivered.promise, new Promise((resolve) => setTimeout(resolve, 300))])
      expect(jest.mocked(host.report).mock.calls).toEqual([])
      expect(backend.workers.create).toHaveBeenCalledTimes(1)
      expect(backend.job).toHaveBeenCalledWith({ repository: 21, run: 33, job: 55 }, expect.any(AbortSignal))
    } finally {
      abort.abort()
      await task
    }
  })
  const observePhase = (status: 'in_progress' | 'completed', job: number, runner: number | null = null) => {
    const secret = Buffer.alloc(32, 1)
    const raw = Buffer.from(
      JSON.stringify({
        action: status,
        installation: { id: 1 },
        repository: { id: 21, owner: { id: 7 } },
        workflow_job: { id: job, run_id: 33, status, labels: ['boxlite'], runner_id: runner },
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
  it('ignores a freshly replayed queued notification when the authoritative queue is empty', async () => {
    const settled = deferred()
    const commit = state.commit.bind(state)
    jest.spyOn(state, 'commit').mockImplementation(async (...args) => {
      const result = await commit(...args)
      if (args[1].some((write) => write.key === 'notice/1/55' && write.payload === undefined)) settled.resolve()
      return result
    })
    Object.assign(backend, { inventory: jest.fn(async () => []) })
    jest.mocked(host.scan).mockResolvedValue({ queued: async () => [], publish: async () => {}, close: async () => {} })
    await listener.receive(notification())
    await runUntil(settled.promise)
    expect(backend.workers.create).not.toHaveBeenCalled()
    expect((await inspectJournal(state, lease)).allocations.size).toBe(0)
    expect(backend.queued).toHaveBeenCalledWith(21, expect.any(AbortSignal))
  })
  it('does not expand from a fresh notification when its authoritative job cannot be read', async () => {
    const failed = deferred()
    Object.assign(backend, { inventory: jest.fn(async () => []) })
    jest.mocked(host.scan).mockResolvedValue({ queued: async () => [], publish: async () => {}, close: async () => {} })
    jest.mocked(backend.queued).mockRejectedValue(new Error('queue unavailable'))
    jest.mocked(backend.job).mockRejectedValue(new Error('queue unavailable'))
    jest.mocked(host.report).mockImplementation((error, operation) => {
      if (error instanceof Error && error.message === 'queue unavailable' && operation === 'queue-reconciliation')
        failed.resolve()
    })
    await listener.receive(notification())
    await runUntil(failed.promise)
    expect(backend.workers.create).not.toHaveBeenCalled()
    expect(await state.read(['notice/1/55'])).toHaveLength(1)
  })
  it('continues original stopped Box cleanup when a dirty queue refresh fails', async () => {
    const failed = deferred(),
      removed = deferred()
    jest.mocked(backend.workers.remove).mockImplementation(async () => removed.resolve())
    Object.assign(backend, { inventory: jest.fn(async () => []) })
    jest.mocked(host.scan).mockResolvedValue({ queued: async () => [], publish: async () => {}, close: async () => {} })
    jest
      .mocked(backend.queued)
      .mockResolvedValue([{ repository: 21, run: 33, job: 55, status: 'queued', runner: null, labels: ['boxlite'] }])
    jest.mocked(backend.workers.deliverJit).mockImplementation(async () => {
      const box = await jest.mocked(backend.workers.create).mock.results[0].value
      jest.mocked(backend.workers.get).mockResolvedValue({ ...box, status: 'stopped' })
      const [counter] = await state.recover(lease, 1000, ['demand/'])
      await state.commit(lease, [
        { key: counter.key, expected: counter.version, payload: { ...(counter.payload as object), dirty: true } },
      ])
      jest.mocked(backend.queued).mockRejectedValue(new Error('queue unavailable'))
      jest.mocked(backend.job).mockRejectedValue(new Error('queue unavailable'))
    })
    jest.mocked(host.report).mockImplementation((error, operation) => {
      if (error instanceof Error && error.message === 'queue unavailable' && operation === 'queue-reconciliation')
        failed.resolve()
    })
    await listener.receive(notification())
    await runUntil(Promise.all([failed.promise, removed.promise]).then(() => {}))
    expect(backend.workers.remove).toHaveBeenCalledTimes(1)
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
  })
  it('cleans a stopped Box with fresh positive notices while both GitHub job reads fail', async () => {
    const cleaned = deferred(),
      failedQueue = deferred(),
      failedJob = deferred()
    const journal = new ExecutionJournal(state)
    await journal.initialize()
    const original = (await state.acquire('former-owner', 300000))!,
      key = await journal.define(original, scope),
      pool = new WorkerPool(
        journal,
        key,
        async () => backend,
        settings,
        () => {},
      )
    await pool.tick(original, testCapacity({ account: 2, tenant: 2 }), { repository: 21, run: 33, job: 55 })
    await pool.close()
    const box = await jest.mocked(backend.workers.create).mock.results[0].value
    let removed = false
    jest.mocked(backend.workers.get).mockImplementation(async () => {
      if (removed) throw new ConfirmedWorkerAbsent()
      return { ...box, status: 'stopped' }
    })
    jest.mocked(backend.workers.remove).mockImplementation(async () => {
      removed = true
      cleaned.resolve()
    })
    Object.assign(backend, { inventory: jest.fn(async () => []) })
    jest.mocked(backend.queued).mockRejectedValue(new Error('queue unavailable'))
    jest.mocked(backend.job).mockRejectedValue(new Error('job unavailable'))
    jest.mocked(host.scan).mockResolvedValue({ queued: async () => [], publish: async () => {}, close: async () => {} })
    jest.mocked(host.report).mockImplementation((error) => {
      if (!(error instanceof Error)) return
      if (error.message === 'queue unavailable') failedQueue.resolve()
      if (error.message === 'job unavailable') failedJob.resolve()
    })
    await db.transaction(namespace, async (tx) => {
      const expiry = (await tx.get('@lease', true))!
      await tx.put({ ...expiry, version: randomUUID(), payload: { until: 0 } }, expiry.version)
    })
    await listener.receive(notification(56))
    await runUntil(Promise.all([cleaned.promise, failedQueue.promise, failedJob.promise]).then(() => {}))
    expect(backend.queued).toHaveBeenCalled()
    expect(backend.job).toHaveBeenCalled()
    expect(backend.workers.remove).toHaveBeenCalledTimes(1)
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
    expect(await state.read(['notice/1/56'])).toHaveLength(1)
  })
  it.each([false, true])(
    'uses database time for queue proof admission and final expiry; expires=%s',
    async (expires) => {
      let databaseNow = Date.now()
      state = new ListenerState(
        {
          transaction: (ns, work) =>
            db.transaction(ns, (tx) => {
              const wrapped = Object.create(tx) as typeof tx
              wrapped.now = async () => databaseNow
              return work(wrapped)
            }),
        },
        namespace,
      )
      const clock = jest.spyOn(Date, 'now').mockImplementation(() => databaseNow + (expires ? -31000 : 31000))
      Object.assign(backend, { inventory: jest.fn(async () => []) })
      jest.mocked(backend.job).mockRejectedValue(new Error('only full queue evidence is available'))
      jest
        .mocked(backend.queued)
        .mockResolvedValue([{ repository: 21, run: 33, job: 55, status: 'queued', runner: null, labels: ['boxlite'] }])
      jest
        .mocked(host.scan)
        .mockResolvedValue({ queued: async () => [], publish: async () => {}, close: async () => {} })
      const pumped = deferred()
      let pumps = 0,
        verified = false
      const recover = state.recover.bind(state)
      jest.spyOn(state, 'recover').mockImplementation(async (...args) => {
        const rows = await recover(...args)
        if (args[2]?.includes('notice/') && ++pumps === 12) pumped.resolve()
        return rows
      })
      const balance = WorkerPool.prototype.balance
      const checked = jest.spyOn(WorkerPool.prototype, 'balance').mockImplementation(async function (
        this: WorkerPool,
        ...args
      ) {
        if (args[4] === true && args[5]?.length) {
          verified = true
          if (expires) databaseNow = args[5][0].expiresAt!
        }
        return balance.apply(this, args)
      })
      listener = new Listener({
        state,
        host: withScanCatalog(host),
        worker: settings,
        capacity: { resolve: async () => testCapacity({ account: 1, tenant: 1 }) },
        timing: { tickMs: 1, leaseMs: 300000 },
      })
      try {
        await runUntil(pumped.promise)
        expect(verified).toBe(true)
        expect(backend.workers.create).toHaveBeenCalledTimes(expires ? 0 : 1)
        if (expires) expect(host.report).toHaveBeenCalledWith(expect.any(StateConflict), 'label-capacity-balance')
      } finally {
        checked.mockRestore()
        clock.mockRestore()
      }
    },
  )
  it('refreshes aged positive counts before reserving from the current queue', async () => {
    Object.assign(backend, { inventory: jest.fn(async () => []) })
    jest
      .mocked(backend.queued)
      .mockResolvedValue([{ repository: 21, run: 33, job: 55, status: 'queued', runner: null, labels: ['boxlite'] }])
    await listener.receive(notification())
    await db.transaction(namespace, async (tx) => {
      const [row] = await tx.page('', 10, 'demand/')
      await tx.put(
        {
          ...row,
          version: randomUUID(),
          payload: {
            ...(row.payload as object),
            queued: 99,
            updatedAt: Date.now() - 30001,
          },
        },
        row.version,
      )
    })
    await runUntil(delivered.promise)
    const [counter] = await state.recover(lease, 1000, ['demand/'])
    expect(counter.payload).toMatchObject({ queued: 1, dirty: false })
    expect(backend.queued).toHaveBeenCalledWith(21, expect.any(AbortSignal))
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
    expect(backend.job).toHaveBeenCalled()
  })
  it('rebuilds a legacy notice without an aggregate before label admission', async () => {
    Object.assign(backend, { inventory: jest.fn(async () => []) })
    jest
      .mocked(backend.queued)
      .mockResolvedValue([{ repository: 21, run: 33, job: 55, status: 'queued', runner: null, labels: ['boxlite'] }])
    const { observation: _observation, ...legacy } = notification()
    await listener.receive(legacy)
    await runUntil(delivered.promise)
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
    expect(backend.job).toHaveBeenCalled()
    expect((await state.recover(lease, 1000, ['demand/']))[0].payload).toMatchObject({ queued: 1, dirty: false })
  })
  it('retries a conflicting repository scan from fresh counters and wake before balancing', async () => {
    const balanced = deferred()
    jest.mocked(host.scan).mockResolvedValue({ queued: async () => [], publish: async () => {}, close: async () => {} })
    Object.assign(backend, { inventory: jest.fn(async () => []) })
    await listener.receive(notification())
    await db.transaction(namespace, async (tx) => {
      const [row] = await tx.page('', 10, 'demand/')
      await tx.put({ ...row, version: randomUUID(), payload: { ...(row.payload as object), dirty: true } }, row.version)
    })
    let reads = 0
    const observations: { wake: string; queued: number }[] = []
    jest.mocked(backend.queued).mockImplementation(async () => {
      const [wake] = await state.read(['queue-revision/1/21'])
      const [counter] = await state.recover(lease, 1000, ['demand/'])
      observations.push({ wake: wake.version, queued: (counter.payload as { queued: number }).queued })
      if (++reads === 1) {
        await listener.receive(observePhase('completed', 55))
        return [{ repository: 21, run: 33, job: 55, status: 'queued', runner: null, labels: ['boxlite'] }]
      }
      return []
    })
    const ingress = state.ingress.bind(state)
    jest.spyOn(state, 'ingress').mockImplementation(async (...args) => {
      const result = await ingress(...args)
      const [row] = await state.recover(lease, 1000, ['demand/'])
      if (
        (row?.payload as { queued?: number; dirty?: boolean })?.queued === 0 &&
        (row.payload as { dirty?: boolean }).dirty === false
      )
        balanced.resolve()
      return result
    })
    await runUntil(balanced.promise)
    expect(observations[0].wake).not.toBe(observations[1].wake)
    expect(observations.slice(0, 2).map((read) => read.queued)).toEqual([1, 0])
    expect((await state.recover(lease, 1000, ['demand/']))[0].payload).toMatchObject({ queued: 0, dirty: false })
    expect(host.report).not.toHaveBeenCalledWith(expect.any(StateCorrupt), 'queue-reconciliation')
    expect(backend.workers.create).not.toHaveBeenCalled()
  })
  it('admits verified jobs while another repository snapshot remains incomplete', async () => {
    const settled = deferred()
    const commit = state.commit.bind(state)
    jest.spyOn(state, 'commit').mockImplementation(async (...args) => {
      const result = await commit(...args)
      if (args[1].some((write) => write.key === 'notice/1/56' && write.payload === undefined)) settled.resolve()
      return result
    })
    scope.installation.account.type = 'Organization'
    scope.runners = {
      kind: 'organization',
      account: { id: 7, login: 'owner' },
      group: 5,
      repositories: [21, 22],
      allowPrivate: true,
      allowPublic: false,
    }
    jest.mocked(host.scan).mockResolvedValue({ queued: async () => [], publish: async () => {}, close: async () => {} })
    Object.assign(backend, { inventory: jest.fn(async () => []) })
    await listener.receive(notification())
    const { observation: _observation, ...legacy } = notification(56, 1, 7, 22)
    await listener.receive(legacy)
    await db.transaction(namespace, async (tx) => {
      const [row] = await tx.page('', 10, 'demand/')
      await tx.put(
        { ...row, version: randomUUID(), payload: { ...(row.payload as object), queued: 99, dirty: true } },
        row.version,
      )
    })
    let conflictingReads = 0
    jest.mocked(backend.queued).mockImplementation(async (repository) => {
      if (repository === 21) {
        conflictingReads++
        await listener.receive(notification())
      }
      return [
        { repository, run: 33, job: repository === 21 ? 55 : 56, status: 'queued', runner: null, labels: ['boxlite'] },
      ]
    })
    await runUntil(delivered.promise)
    const allocations = [...(await inspectJournal(state, lease)).allocations.values()]
    expect(allocations).toHaveLength(1)
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
    expect(conflictingReads).toBeGreaterThan(0)
    expect(await state.read(['notice/1/55'])).toHaveLength(1)
    expect((await state.recover(lease, 1000, ['demand/1/21/']))[0].payload).toMatchObject({ queued: 99, dirty: true })
  })
  it('repairs an unreadable aggregate without carrying its deleted snapshot into admission', async () => {
    const repaired = deferred()
    Object.assign(backend, { inventory: jest.fn(async () => []) })
    await listener.receive(notification())
    await db.transaction(namespace, async (tx) => {
      const [row] = await tx.page('', 10, 'demand/')
      await tx.put({ ...row, version: randomUUID(), payload: { broken: true } }, row.version)
    })
    const ingress = state.ingress.bind(state)
    jest.spyOn(state, 'ingress').mockImplementation(async (...args) => {
      const result = await ingress(...args)
      if (!(await state.recover(lease, 1000, ['demand/'])).length) repaired.resolve()
      return result
    })
    await runUntil(repaired.promise)
    expect(await state.recover(lease, 1000, ['demand/'])).toEqual([])
    expect(backend.workers.create).not.toHaveBeenCalled()
    expect(host.report).not.toHaveBeenCalledWith(expect.any(StateCorrupt), 'label-capacity-balance')
  })
  it('rebuilds dirty demand before reserving capacity', async () => {
    Object.assign(backend, { inventory: jest.fn(async () => []) })
    jest
      .mocked(backend.queued)
      .mockResolvedValue([{ repository: 21, run: 33, job: 55, status: 'queued', runner: null, labels: ['boxlite'] }])
    await listener.receive(notification())
    await db.transaction(namespace, async (tx) => {
      const [row] = await tx.page('', 10, 'demand/')
      await tx.put(
        { ...row, version: randomUUID(), payload: { ...(row.payload as object), queued: 99, dirty: true } },
        row.version,
      )
    })
    await runUntil(delivered.promise)
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
    const [counter] = await state.recover(lease, 1000, ['demand/'])
    expect(counter.payload).toMatchObject({ queued: 1, dirty: false })
    expect(backend.job).toHaveBeenCalled()
  })
  it('uses a queue fallback for busy PAT-style supply without webhook claim observations', async () => {
    let busy = false,
      name = ''
    const repaired = deferred()
    Object.assign(backend, {
      inventory: jest.fn(async () => {
        const rows = await db.transaction(namespace, (tx) => tx.page('', 100, 'demand/'))
        if (busy && rows.some((row) => (row.payload as { queued: number }).queued === 0)) repaired.resolve()
        return name ? [{ id: 91, name, busy, status: 'online', labels: ['boxlite'] }] : []
      }),
    })
    jest.mocked(backend.workers.deliverJit).mockImplementation(async (runnerName) => {
      name = runnerName
      busy = true
    })
    jest.mocked(backend.queued).mockImplementation(async () => {
      if (busy) return []
      return [{ repository: 21, run: 33, job: 55, status: 'queued', runner: null, labels: ['boxlite'] }]
    })
    listener = new Listener({
      state,
      host: withScanCatalog(host),
      worker: settings,
      capacity: { resolve: async () => testCapacity({ account: 2, tenant: 2 }) },
      timing: { tickMs: 1, leaseMs: 3000 },
    })
    jest.mocked(backend.job).mockImplementation(async (notice) => ({
      ...notice,
      status: busy ? 'in_progress' : 'queued',
      runner: busy ? 91 : null,
      labels: ['boxlite'],
    }))
    await listener.receive(notification())
    await runUntil(repaired.promise)
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
    expect((await state.recover(lease, 1000, ['demand/']))[0].payload).toMatchObject({ queued: 0, dirty: false })
  })
  it('fences a reservation when a completion changes demand during inventory lookup', async () => {
    const rejected = deferred()
    let reads = 0
    jest
      .mocked(backend.queued)
      .mockResolvedValue([{ repository: 21, run: 33, job: 55, status: 'queued', runner: null, labels: ['boxlite'] }])
    Object.assign(backend, {
      inventory: jest.fn(async () => {
        if (++reads === 1) await listener.receive(observePhase('completed', 55))
        return []
      }),
    })
    jest.mocked(host.report).mockImplementation((_error, operation) => {
      if (operation === 'label-capacity-balance') rejected.resolve()
    })
    await listener.receive(notification())
    await runUntil(rejected.promise)
    expect(backend.workers.create).not.toHaveBeenCalled()
    expect((await inspectJournal(state, lease)).allocations.size).toBe(0)
  })
  it('does not use another account counter inside a matching installation scope', async () => {
    const denied = deferred()
    Object.assign(backend, { inventory: jest.fn(async () => []) })
    jest.mocked(host.report).mockImplementation((error, operation) => {
      if (error instanceof StateCorrupt && operation === 'label-capacity-balance') denied.resolve()
    })
    await listener.receive(notification(55, 1, 8))
    await runUntil(denied.promise)
    expect(backend.workers.create).not.toHaveBeenCalled()
  })
  it('replenishes label capacity when a triggering job runner claims another job', async () => {
    jest
      .mocked(backend.queued)
      .mockResolvedValue([{ repository: 21, run: 33, job: 55, status: 'queued', runner: null, labels: ['boxlite'] }])
    const inventory = new Map<number, { id: number; name: string; busy: boolean; status: 'online'; labels: string[] }>()
    let nextId = 100
    const second = deferred()
    Object.assign(backend, { inventory: jest.fn(async () => [...inventory.values()].map((row) => ({ ...row }))) })
    jest.mocked(backend.runners).mockImplementation(async (guard) => ({
      registry: {
        create: jest.fn(async (name) => {
          await guard({ kind: 'register', name })
          const runner = { id: ++nextId, name, busy: false, status: 'online' as const, labels: ['boxlite'] }
          inventory.set(runner.id, runner)
          return new JitRegistration(runner, 'c2VjcmV0')
        }),
        lookup: jest.fn(async (identity) => [...inventory.values()].find((row) => row.name === identity.name) ?? null),
        remove: jest.fn(async () => {}),
      },
      close: jest.fn(async () => {}),
    }))
    jest.mocked(backend.workers.deliverJit).mockImplementation(async (name) => {
      const runner = [...inventory.values()].find((row) => row.name === name)!
      runner.busy = true
      if (inventory.size === 1) {
        // GitHub assigns this runner to B while the original trigger A remains queued.
        const secret = Buffer.alloc(32, 1)
        const raw = Buffer.from(
          JSON.stringify({
            action: 'in_progress',
            installation: { id: 1 },
            repository: { id: 21, owner: { id: 7 } },
            workflow_job: { id: 56, run_id: 33, status: 'in_progress', labels: ['boxlite'], runner_id: runner.id },
          }),
        )
        const claimed = verifyWebhook(
          {
            raw,
            delivery: randomUUID(),
            event: 'workflow_job',
            signature: 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex'),
          },
          secret,
        )
        // Compatibility with the original verifier reaches the per-job guard even
        // when that verifier legitimately ignores non-queued wake notifications.
        if (claimed) await listener.receive(claimed)
      } else second.resolve()
    })
    listener = new Listener({
      state,
      host: withScanCatalog(host),
      worker: settings,
      capacity: { resolve: async () => testCapacity({ account: 2, tenant: 2 }) },
      timing: { tickMs: 1, leaseMs: 3000 },
    })
    await listener.receive(notification(55))
    const task = listener.run(abort.signal)
    const timeout = setTimeout(() => abort.abort(), 2000)
    try {
      await Promise.race([second.promise, task])
    } finally {
      clearTimeout(timeout)
      abort.abort()
      await task
    }
    expect(backend.workers.create).toHaveBeenCalledTimes(2)
    expect(backend.job).toHaveBeenCalled()
    expect((await inspectJournal(state, lease)).workers).toHaveLength(2)
  })
  it('creates all missing label capacity concurrently within the organization quota', async () => {
    jest.mocked(backend.queued).mockResolvedValue(
      Array.from({ length: 17 }, (_, index) => ({
        repository: 21,
        run: 33,
        job: index + 100,
        status: 'queued' as const,
        runner: null,
        labels: ['boxlite'],
      })),
    )
    const release = deferred(),
      entered = deferred()
    let inFlight = 0,
      maximum = 0
    Object.assign(backend, { inventory: jest.fn(async () => []) })
    const create = jest.mocked(backend.workers.create).getMockImplementation()!
    jest.mocked(backend.workers.create).mockImplementation(async (launch) => {
      inFlight++
      maximum = Math.max(maximum, inFlight)
      if (inFlight === 16) entered.resolve()
      await release.promise
      try {
        return await create(launch)
      } finally {
        inFlight--
      }
    })
    let runnerId = 100
    jest.mocked(backend.runners).mockImplementation(async (guard) => ({
      registry: {
        create: jest.fn(async (name) => {
          await guard({ kind: 'register', name })
          return new JitRegistration({ id: ++runnerId, name }, 'c2VjcmV0')
        }),
        lookup: jest.fn(async () => null),
        remove: jest.fn(async () => {}),
      },
      close: jest.fn(async () => {}),
    }))
    listener = new Listener({
      state,
      host: withScanCatalog(host),
      worker: settings,
      capacity: { resolve: async () => testCapacity({ account: 16, tenant: 16 }) },
      timing: { tickMs: 1, leaseMs: 10000 },
    })
    for (let job = 100; job < 117; job++) await listener.receive(notification(job))
    const task = listener.run(abort.signal)
    const timeout = setTimeout(() => {
      abort.abort()
      release.resolve()
    }, 3000)
    try {
      await Promise.race([entered.promise, task])
    } finally {
      clearTimeout(timeout)
      abort.abort()
      release.resolve()
      await task
    }
    expect(maximum).toBe(16)
    expect(backend.workers.create).toHaveBeenCalledTimes(16)
    expect((await inspectJournal(state, lease)).workers).toHaveLength(16)
  })
  it('continues valid scope admission when another discovered definition is invalid', async () => {
    const discover = jest.mocked(host.discover).getMockImplementation()!
    jest.mocked(host.discover).mockImplementation(async (...args) => ({
      ...(await discover(...args)),
      scopes: [{ ...scope, binding: 'invalid-binding', actor: '' }, scope],
    }))
    await listener.receive(notification())
    await runUntil(delivered.promise)
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
    expect(host.report).toHaveBeenCalledWith(expect.any(Error), 'scope-definition')
    expect((await inspectJournal(state, lease)).scopes.size).toBe(1)
  })
  it('retries a transient journal initialization failure before scheduling', async () => {
    await listener.receive(notification())
    const initialize = jest.spyOn(state, 'initialize').mockRejectedValueOnce(new Error('initialization unavailable'))
    try {
      await runUntil(delivered.promise)
      expect(initialize.mock.calls.length).toBeGreaterThan(1)
      expect(host.report).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'initialization unavailable' }),
        'listener-session',
      )
      expect(backend.workers.create).toHaveBeenCalledTimes(1)
    } finally {
      initialize.mockRestore()
    }
  })
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
      host: withScanCatalog(host),
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
      host: withScanCatalog(host),
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
    const snapshot = await inspectJournal(state, lease),
      allocation = [...snapshot.allocations.values()][0]
    expect(allocation.value).toMatchObject({
      delivery: 'done',
      box: { phase: 'known' },
      runner: { phase: 'known', id: 91 },
    })
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
    expect(backend.workers.deliverJit).toHaveBeenCalledTimes(1)
    expect(backend.close).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(snapshot.usage)).not.toContain('c2VjcmV0')
    expect(host.report).not.toHaveBeenCalled()
  })
  it('creation refusal boundary: keeps the queued notice and logs the original rejected operation', async () => {
    const observed = deferred()
    const observe = jest.fn((event: { event: string }) => {
      if (event.event === 'ci-worker-create-rejected') observed.resolve()
    })
    Object.assign(host, { observe })
    jest.mocked(backend.workers.create).mockImplementationOnce(async (launch) => {
      const rows = await inspectJournal(state, lease)
      const row = [...rows.allocations.values()].find((item) => item.value.name === launch.name)!
      throw new ConfirmedWorkerCreationRejected(row.value.effect!.id)
    })
    await listener.receive(notification())
    await runUntil(observed.promise)
    expect((await ingressRows()).some((row) => row.key === 'notice/1/55')).toBe(true)
    expect((await inspectJournal(state, lease)).allocations.size).toBe(0)
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
      limits: [{ maximum: request.repository === 21 ? 0 : 1, domain: 'global' as const }],
    }))
    listener = new Listener({
      state,
      host: withScanCatalog(host),
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
    const snapshot = await inspectJournal(state, lease)
    expect([...snapshot.allocations.values()].map((row) => row.value.job!.repository)).toEqual([22])
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
  })
  it.each([false, true])('handles a webhook that wins compensation publication; conflicting=%s', async (conflict) => {
    jest
      .mocked(backend.queued)
      .mockResolvedValue([{ repository: 21, run: 33, job: 55, status: 'queued', labels: ['boxlite'], runner: null }])
    const publish = publishScan.getMockImplementation()!,
      reported = deferred()
    let injected = false
    jest.mocked(host.report).mockImplementation(() => reported.resolve())
    publishScan.mockImplementation(async (claim, jobs) => {
      if (!injected) {
        injected = true
        await listener.receive(notification(55, 1, conflict ? 8 : 7))
      }
      return publish(claim, jobs)
    })
    await runUntil(conflict ? reported.promise : delivered.promise)
    expect(injected).toBe(true)
    if (conflict) {
      expect(host.report).toHaveBeenCalledWith(expect.any(StateCorrupt), expect.any(String))
      expect(backend.workers.create).not.toHaveBeenCalled()
    } else {
      expect(host.report).not.toHaveBeenCalled()
      expect(backend.workers.create).toHaveBeenCalledTimes(1)
    }
  })
  it('dispatches a webhook job while a compensation scan is blocked', async () => {
    const entered = deferred(),
      release = deferred()
    jest.mocked(backend.queued).mockImplementation(async () => {
      entered.resolve()
      await release.promise
      return []
    })
    const running = listener.run(abort.signal)
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      await entered.promise
      await listener.receive(notification())
      await Promise.race([
        delivered.promise,
        new Promise<void>((resolve) => {
          deadline = setTimeout(resolve, 1000)
        }),
      ])
      expect(backend.workers.deliverJit).toHaveBeenCalledTimes(1)
    } finally {
      clearTimeout(deadline)
      release.resolve()
      abort.abort()
      await running.catch(() => {})
    }
  })
  it('compensates a missed webhook by recording the scanned job before dispatching it', async () => {
    jest
      .mocked(backend.queued)
      .mockResolvedValue([{ repository: 21, run: 33, job: 55, status: 'queued', labels: ['boxlite'], runner: null }])
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
      labels: ['boxlite'],
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
      checked = deferred()
    jest.mocked(backend.job).mockImplementation(async (notice) => {
      entered.resolve()
      await resume.promise
      return { ...notice, status: 'completed', labels: ['boxlite'], runner: null }
    })
    const [original] = await state.read(['notice/1/55'])
    const commit = state.commit.bind(state)
    let newerVersion = '',
      staleRejected = false
    jest.spyOn(state, 'commit').mockImplementation(async (...args) => {
      try {
        return await commit(...args)
      } catch (error) {
        if (
          error instanceof StateConflict &&
          args[1].some(
            (change) =>
              change.key === original.key && change.expected === original.version && change.payload === undefined,
          )
        ) {
          expect((await state.read([original.key]))[0].version).toBe(newerVersion)
          staleRejected = true
          checked.resolve()
        }
        throw error
      }
    })
    const test = (async () => {
      await entered.promise
      await listener.receive(notification())
      newerVersion = (await state.read([original.key]))[0].version
      resume.resolve()
    })()
    await runUntil(checked.promise)
    await test
    expect(staleRejected).toBe(true)
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
  it('keeps notices pending while only a retired counted scope can recover resources', async () => {
    const journal = new ExecutionJournal(state)
    await journal.initialize()
    const previous = (await state.acquire('previous-owner', 3000))!
    const key = await journal.define(previous, scope)
    await journal.reserve(previous, key, { repository: 21, run: 33, job: 54 }, testCapacity({ account: 1, tenant: 2 }))
    await db.transaction(namespace, async (tx) => {
      const row = (await tx.get('@lease', true))!
      await tx.put({ ...row, version: randomUUID(), payload: { until: 0 } }, row.version)
    })
    Object.assign(backend, { inventory: jest.fn(async () => []) })
    jest.mocked(backend.workers.create).mockRejectedValue(new Error('Original creation outcome pending'))
    jest.mocked(backend.workers.get).mockRejectedValue(new Error('Original Box not yet observed'))
    jest.mocked(host.discover).mockImplementation(async (owner) => {
      lease = owner
      return { scopes: [], completed: [], pending: true, ready: true }
    })
    const observed = deferred(),
      recover = state.recover.bind(state)
    let cycles = 0
    jest.spyOn(state, 'recover').mockImplementation(async (owner, maximum, prefixes) => {
      const rows = await recover(owner, maximum, prefixes)
      if (prefixes?.includes('notice/') && ++cycles === 3) observed.resolve()
      return rows
    })
    await listener.receive(notification())
    await runUntil(observed.promise)
    expect((await ingressRows()).some((row) => row.key === 'notice/1/55')).toBe(true)
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
      const row = (await tx.get('@lease', true))!
      await tx.put({ ...row, version: randomUUID(), payload: { ...(row.payload as object), until: 0 } }, row.version)
    })
    const failed = deferred()
    jest.mocked(host.report).mockImplementation(() => failed.resolve())
    await runUntil(failed.promise)
    expect(host.discover).not.toHaveBeenCalled()
    expect(backend.workers.create).not.toHaveBeenCalled()
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
        await inspectJournal(state, current)
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
    expect((await inspectJournal(state, lease)).allocations.size).toBe(1)
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
    expect((await ingressRows()).some((row) => row.key === 'notice/1/56')).toBe(true)
    expect(jest.mocked(backend.job).mock.calls.map(([notice]) => notice.job)).not.toContain(56)
    // Selection, admission and the pre-create resource reread happen once; full capacity adds no reads.
    expect(backend.job).toHaveBeenCalledTimes(3)
    expect(backend.queued).toHaveBeenCalled()
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
        allowPrivate: true,
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
        const row = (await tx.get('@lease', true))!
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
        host: withScanCatalog(host),
        worker: settings,
        capacity: { resolve: async () => testCapacity({ account: 2, tenant: 1 }) },
        timing: { tickMs: 1, leaseMs: 3000 },
      })
      await runUntil(observed.promise)
      expect(new Set(jest.mocked(backend.queued).mock.calls.map(([repository]) => repository))).toEqual(
        new Set([21, 22]),
      )
      expect(
        (await inspectJournal(state, lease)).workers.filter((worker) => worker.organization === scope.organization),
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
      allowPrivate: true,
      allowPublic: false,
    }
    const journal = new ExecutionJournal(state)
    await journal.initialize()
    const original = (await state.acquire('old-owner', 3000))!,
      key = await journal.define(original, scope)
    await journal.reserve(original, key, { repository: 21, run: 33, job: 55 }, testCapacity({ account: 1, tenant: 2 }))
    await db.transaction(namespace, async (tx) => {
      const row = (await tx.get('@lease', true))!
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
    expect((await inspectJournal(state, lease)).allocations.size).toBe(2)
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
  it('ends a superseded deployment after retiring local owners without deleting its running worker', async () => {
    state = new ListenerState(db, namespace, 1)
    await new ExecutionJournal(state).initialize()
    await state.activate()
    const close = jest.fn(async () => {})
    listener = new Listener({
      state,
      host: Object.assign(withScanCatalog(host), { close }),
      worker: settings,
      capacity: { resolve: async () => testCapacity({ account: 1, tenant: 2 }) },
      timing: { tickMs: 1, leaseMs: 3000 },
    })
    await listener.receive(notification())
    const replacement = new ListenerState(db, namespace, 2)
    let current!: ExecutionLease
    jest.mocked(backend.workers.deliverJit).mockImplementationOnce(async () => {
      await replacement.activate()
      current = (await replacement.acquire('new-deployment', 300000))!
      delivered.resolve()
    })
    const deadline = setTimeout(() => abort.abort(), 1000)
    try {
      await listener.run(abort.signal)
      expect(abort.signal.aborted).toBe(false)
      expect(close).toHaveBeenCalledTimes(2)
      expect(backend.close).toHaveBeenCalled()
      expect(backend.workers.stop).not.toHaveBeenCalled()
      expect(backend.workers.remove).not.toHaveBeenCalled()
      expect((await inspectJournal(replacement, current)).allocations.size).toBe(1)
      await expect(listener.receive(notification(56))).resolves.toBe('stored')
    } finally {
      clearTimeout(deadline)
      abort.abort()
    }
  })
  it('retires independent deployment owners while an uncancellable create is still pending', async () => {
    state = new ListenerState(db, namespace, 1)
    await new ExecutionJournal(state).initialize()
    await state.activate()
    const entered = deferred(),
      release = deferred(),
      closed = deferred()
    const close = jest.fn(async () => closed.resolve())
    jest.mocked(backend.workers.create).mockImplementation(async () => {
      entered.resolve()
      await release.promise
      return { box_id: 'late-created-box', status: 'running' }
    })
    listener = new Listener({
      state,
      host: Object.assign(withScanCatalog(host), { close }),
      worker: settings,
      capacity: { resolve: async () => testCapacity({ account: 1, tenant: 2 }) },
      timing: { tickMs: 1, leaseMs: 300 },
    })
    await listener.receive(notification())
    const replacement = new ListenerState(db, namespace, 2)
    const running = listener.run(abort.signal)
    let stopped = false
    void running.then(
      () => {
        stopped = true
      },
      () => {
        stopped = true
      },
    )
    try {
      await entered.promise
      await replacement.activate()
      const result = await Promise.race([
        closed.promise.then(() => 'closed'),
        new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 500)),
      ])
      expect(result).toBe('closed')
      expect(stopped).toBe(false)
      expect(backend.workers.stop).not.toHaveBeenCalled()
      expect(backend.workers.remove).not.toHaveBeenCalled()
      release.resolve()
      await running
      const current = (await replacement.acquire('replacement', 3000))!
      const active = await inspectJournal(replacement, current)
      expect(active.allocations.size).toBe(1)
      expect([...active.allocations.values()][0].value.box.phase).toBe('requested')
    } finally {
      release.resolve()
      abort.abort()
      await running.catch(() => {})
    }
  })
  it('ends an already superseded deployment before opening discovery or worker backends', async () => {
    state = new ListenerState(db, namespace, 1)
    await new ExecutionJournal(state).initialize()
    await state.activate()
    const replacement = new ListenerState(db, namespace, 2)
    await replacement.activate()
    const close = jest.fn(async () => {})
    listener = new Listener({
      state,
      host: Object.assign(withScanCatalog(host), { close }),
      worker: settings,
      capacity: { resolve: async () => testCapacity({ account: 1, tenant: 2 }) },
      timing: { tickMs: 1, leaseMs: 3000 },
    })
    const deadline = setTimeout(() => abort.abort(), 500)
    try {
      await listener.run(abort.signal)
      expect(abort.signal.aborted).toBe(false)
      expect(close).toHaveBeenCalledTimes(2)
      expect(host.discover).not.toHaveBeenCalled()
      expect(host.backend).not.toHaveBeenCalled()
    } finally {
      clearTimeout(deadline)
      abort.abort()
    }
  })
  it.each([false, true])('drains known owners while a scan is opening (revocation retries: %s)', async (retry) => {
    state = new ListenerState(db, namespace, 1)
    await new ExecutionJournal(state).initialize()
    await state.activate()
    const opening = deferred(),
      release = deferred(),
      closed = deferred()
    let closes = 0
    const reader = {
      queued: jest.fn(async () => []),
      publish: jest.fn(async () => {}),
      close: jest.fn(async () => {
        if (++closes <= (retry ? 2 : 0)) throw new Error('Late reader revocation pending')
      }),
    }
    jest.mocked(host.scan).mockImplementation(async () => {
      opening.resolve()
      await release.promise
      return reader
    })
    const close = jest.fn(async () => closed.resolve())
    listener = new Listener({
      state,
      host: Object.assign(withScanCatalog(host), { close }),
      worker: settings,
      capacity: { resolve: async () => testCapacity({ account: 1, tenant: 2 }) },
      timing: { tickMs: 1, leaseMs: 3000 },
    })
    await listener.receive(notification())
    const replacement = new ListenerState(db, namespace, 2)
    jest.mocked(backend.workers.deliverJit).mockImplementationOnce(async () => {
      await opening.promise
      await replacement.activate()
    })
    const running = listener.run(abort.signal)
    try {
      const result = await Promise.race([
        closed.promise.then(() => 'closed'),
        new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 500)),
      ])
      expect(result).toBe('closed')
      expect(backend.close).toHaveBeenCalled()
      expect(reader.close).not.toHaveBeenCalled()
      release.resolve()
      await running
      expect(reader.close).toHaveBeenCalled()
      expect(reader.queued).not.toHaveBeenCalled()
      expect(backend.workers.remove).not.toHaveBeenCalled()
    } finally {
      release.resolve()
      abort.abort()
      await running.catch(() => {})
    }
  })
  it('drains every local owner after takeover despite compensation retirement failures', async () => {
    state = new ListenerState(db, namespace, 1)
    await new ExecutionJournal(state).initialize()
    await state.activate()
    const entered = deferred(),
      trace: string[] = []
    let closes = 0
    const reader = {
      queued: async (signal: AbortSignal) => {
        entered.resolve()
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => resolve(), { once: true })
        })
        return []
      },
      publish: async () => {},
      close: jest.fn(async () => {
        trace.push('scan-close-' + ++closes)
        if (closes <= 3) throw new Error('Revocation pending')
      }),
    }
    jest.mocked(host.scan).mockResolvedValue(reader)
    const close = jest.fn(async () => {
      trace.push('host-close')
    })
    listener = new Listener({
      state,
      host: Object.assign(withScanCatalog(host), { close }),
      worker: settings,
      capacity: { resolve: async () => testCapacity({ account: 1, tenant: 2 }) },
      timing: { tickMs: 1, leaseMs: 3000 },
    })
    await listener.receive(notification())
    const replacement = new ListenerState(db, namespace, 2)
    jest.mocked(backend.workers.deliverJit).mockImplementationOnce(async () => {
      await Promise.race([
        entered.promise,
        new Promise<void>((resolve) => {
          abort.signal.addEventListener('abort', () => resolve(), { once: true })
        }),
      ])
      abort.signal.throwIfAborted()
      await replacement.activate()
    })
    const deadline = setTimeout(() => abort.abort(), 1000)
    try {
      await listener.run(abort.signal)
      expect(abort.signal.aborted).toBe(false)
      expect(close).toHaveBeenCalledTimes(3)
      expect(reader.close).toHaveBeenCalledTimes(4)
      expect(trace.indexOf('host-close')).toBeLessThan(trace.indexOf('scan-close-4'))
      expect(backend.workers.remove).not.toHaveBeenCalled()
    } finally {
      clearTimeout(deadline)
      abort.abort()
    }
  })
  it('reports a failed renewal while JIT delivery is still draining under a live lease', async () => {
    const entered = deferred(),
      cancelled = deferred(),
      release = deferred()
    const queryError = new Error('Injected renewal query failure')
    const renewal = jest.spyOn(state, 'renew').mockImplementationOnce(async () => {
      await entered.promise
      throw queryError
    })
    jest.mocked(backend.workers.deliverJit).mockImplementationOnce(async (_name, _jit, signal) => {
      if (!signal) throw new Error('Expected the owner session signal')
      signal.addEventListener('abort', cancelled.resolve, { once: true })
      entered.resolve()
      await release.promise
      signal.throwIfAborted()
    })
    await listener.receive(notification())
    const task = listener.run(abort.signal)
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        cancelled.promise,
        task.then(() => {
          throw new Error('Listener stopped before cancelling the pending JIT delivery')
        }),
        new Promise<void>((_, reject) => {
          deadline = setTimeout(() => reject(new Error('Renewal did not cancel the pending JIT delivery')), 2500)
        }),
      ])
      expect(abort.signal.aborted).toBe(false)
      await expect(state.now(lease)).resolves.toEqual(expect.any(Number))
      expect(host.report).toHaveBeenCalledWith(queryError, 'listener-renewal')
      expect(host.report).not.toHaveBeenCalledWith(queryError, 'listener-session')
    } finally {
      clearTimeout(deadline)
      entered.resolve()
      release.resolve()
      abort.abort()
      await task
      renewal.mockRestore()
    }
  })

  it('renews ownership while a GitHub operation is waiting beyond the original lease expiry', async () => {
    listener = new Listener({
      state,
      host: withScanCatalog(host),
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
  it('rotates capacity planning after a full buffer so later scopes are eventually executed', async () => {
    const definitions = Array.from({ length: 7 }, (_, index) => {
      const current = structuredClone(scope)
      const login = index ? `owner${index}` : 'owner'
      current.binding = `binding-${index}`
      current.installation = { id: index + 1, account: { id: index + 7, login, type: 'User' } }
      current.runners = {
        kind: 'repository',
        repository: {
          id: index + 21,
          owner: { id: index + 7, login },
          name: 'repo',
          private: true,
        },
        allowPublic: false,
        allowPrivate: true,
      }
      return current
    })
    const finished = deferred(),
      seen = new Set<string>()
    const create = jest.mocked(backend.workers.create).getMockImplementation()!
    jest.mocked(host.backend).mockImplementation(async (current) => ({
      ...backend,
      inventory: async () => [],
      queued: async (repository) => [
        { repository, run: 33, job: repository + 34, status: 'queued', labels: ['boxlite'], runner: null },
      ],
      workers: {
        ...backend.workers,
        create: async (launch) => {
          const result = await create(launch)
          seen.add(current.binding)
          if (seen.size === definitions.length) finished.resolve()
          return result
        },
      },
    }))
    jest.mocked(host.discover).mockImplementation(async (owner, _signal, request) => {
      lease = owner
      return { scopes: definitions, completed: request.wakes.map((row) => ({ ...row })), ready: true, pending: false }
    })
    jest.mocked(host.scan).mockResolvedValue({ queued: async () => [], publish: async () => {}, close: async () => {} })
    // The queue unit tests exercise real buffer exhaustion; this boundary forces the
    // same rejection while the real Listener must retain and rotate durable scope work.
    let admitted = 0
    const recover = state.recover.bind(state)
    jest.spyOn(state, 'recover').mockImplementation(async (...args) => {
      if (args[2]?.includes('notice/')) admitted = 0
      return recover(...args)
    })
    const enqueue = WorkQueue.prototype.enqueue
    const bounded = jest.spyOn(WorkQueue.prototype, 'enqueue').mockImplementation(function (this: WorkQueue, ...args) {
      if (args[0].startsWith('scope/') && ++admitted > 3) return false
      return enqueue.apply(this, args)
    })
    listener = new Listener({
      state,
      host: withScanCatalog(host),
      worker: settings,
      capacity: { resolve: async () => testCapacity({ account: 1, tenant: 10 }) },
      timing: { tickMs: 1, leaseMs: 3000 },
    })
    try {
      for (let index = 0; index < definitions.length; index++)
        await listener.receive(notification(index + 55, index + 1, index + 7, index + 21))
      await runUntil(finished.promise)
      expect(seen).toEqual(new Set(definitions.map((current) => current.binding)))
    } finally {
      bounded.mockRestore()
    }
  })
  it('accepts all three scopes once per complete planning pass across four rounds', async () => {
    const definitions: ExecutionScope[] = Array.from({ length: 3 }, (_, index) => ({
      ...scope,
      binding: `planning-${index}`,
      runners: {
        kind: 'repository',
        repository: { id: 21 + index, owner: { id: 7, login: 'owner' }, name: `repo-${index}`, private: true },
        allowPrivate: true,
        allowPublic: false,
      },
    }))
    jest.mocked(host.discover).mockImplementation(async (owner) => {
      lease = owner
      return { scopes: definitions, completed: [], ready: true, pending: false }
    })
    Object.assign(backend, { inventory: jest.fn(async () => []) })
    jest.mocked(host.scan).mockResolvedValue({ queued: async () => [], publish: async () => {}, close: async () => {} })
    let identifiedPlanning = false,
      completed = 0
    const keys = definitions.map((definition) => scopeKey(decodeScope(definition))),
      executed: string[] = [],
      planning = new WeakSet<WorkQueue>(),
      planned = deferred(),
      enqueue = WorkQueue.prototype.enqueue,
      observed = jest.spyOn(WorkQueue.prototype, 'enqueue').mockImplementation(function (this: WorkQueue, ...args) {
        if (!keys.includes(args[0])) return enqueue.apply(this, args)
        if (!identifiedPlanning) {
          planning.add(this)
          identifiedPlanning = true
        }
        if (!planning.has(this)) return enqueue.apply(this, args)
        return enqueue.call(this, args[0], args[1], async (queueWaitMs) => {
          executed.push(args[0])
          await args[2](queueWaitMs)
          if (++completed === 12) planned.resolve()
        })
      })
    try {
      await runUntil(planned.promise)
      for (let round = 0; round < 4; round++) expect(executed.slice(round * 3, round * 3 + 3)).toEqual(keys)
      expect(completed).toBe(12)
      expect(host.report).not.toHaveBeenCalled()
      expect(backend.workers.create).not.toHaveBeenCalled()
    } finally {
      observed.mockRestore()
    }
  })
  it.each([
    [false, 'running'],
    [true, 'running'],
    [false, 'stopped'],
  ] as const)('recovers a pending retirement with returned demand=%s and Box=%s', async (needed, status) => {
    const journal = new ExecutionJournal(state)
    await journal.initialize()
    const original = (await state.acquire('former-owner', 3000))!
    const key = await journal.define(original, scope)
    let row = (await journal.reserve(
      original,
      key,
      { repository: 21, run: 33, job: 55 },
      testCapacity({ account: 1, tenant: 2 }),
    ))!
    row = await journal.advance(original, row.record.key, row.record.version, {
      box: { phase: 'requested', id: null },
      effect: { kind: 'box-create', id: randomUUID() },
    })
    row = await journal.advance(original, row.record.key, row.record.version, {
      box: { phase: 'known', id: 'original-box' },
    })
    row = await journal.advance(original, row.record.key, row.record.version, {
      runner: { phase: 'requested', id: null },
      effect: { kind: 'runner-register', id: randomUUID() },
    })
    row = await journal.advance(original, row.record.key, row.record.version, {
      runner: { phase: 'known', id: 91, registeredAt: Date.now() - 360000 },
      delivery: 'requested',
      effect: { kind: 'jit-deliver', id: randomUUID() },
    })
    row = await journal.advance(original, row.record.key, row.record.version, {
      delivery: 'done',
      effect: { kind: 'runner-retire', id: randomUUID() },
    })
    await db.transaction(namespace, async (tx) => {
      const prior = (await tx.get('@lease', true))!
      await tx.put(
        { ...prior, version: randomUUID(), payload: { ...(prior.payload as object), until: 0 } },
        prior.version,
      )
    })
    const checked = deferred(),
      retired = deferred(),
      removed = deferred()
    const retire = jest.fn(async () => {
      retired.resolve()
      return false
    })
    Object.assign(backend, {
      inventory: jest.fn(async () => [
        ...(status === 'running'
          ? [{ id: 91, name: row.value.name, status: 'online', busy: false, labels: ['boxlite'] }]
          : []),
      ]),
    })
    jest.mocked(backend.workers.get).mockResolvedValue({ box_id: 'original-box', status })
    jest.mocked(backend.workers.remove).mockImplementation(async () => removed.resolve())
    jest
      .mocked(backend.queued)
      .mockResolvedValue(
        needed ? [{ repository: 21, run: 33, job: 55, status: 'queued', labels: ['boxlite'], runner: null }] : [],
      )
    jest.mocked(host.scan).mockResolvedValue({ queued: async () => [], publish: async () => {}, close: async () => {} })
    const open = jest.mocked(backend.runners).getMockImplementation()!
    jest.mocked(backend.runners).mockImplementation(async (...args) => {
      const session = await open(...args)
      session.registry.retireIdle = async (identity) => {
        await args[0]({ kind: 'remove', ...identity })
        return retire()
      }
      return session
    })
    const balance = WorkerPool.prototype.balance
    const balanced = jest.spyOn(WorkerPool.prototype, 'balance').mockImplementation(async function (
      this: WorkerPool,
      ...args
    ) {
      const result = await balance.apply(this, args)
      if (args[4] === true) checked.resolve()
      return result
    })
    try {
      await runUntil(status === 'stopped' ? removed.promise : needed ? checked.promise : retired.promise)
      expect(backend.workers.create).not.toHaveBeenCalled()
      expect(backend.workers.stop).not.toHaveBeenCalled()
      expect(retire).toHaveBeenCalledTimes(needed || status === 'stopped' ? 0 : 1)
    } finally {
      balanced.mockRestore()
    }
  })
  it('starts the first allocation before the second reservation finishes', async () => {
    const entered = deferred(),
      release = deferred(),
      started = deferred()
    Object.assign(backend, { inventory: jest.fn(async () => []) })
    jest.mocked(host.scan).mockResolvedValue({ queued: async () => [], publish: async () => {}, close: async () => {} })
    jest.mocked(backend.queued).mockResolvedValue(
      [55, 56].map((job) => ({
        repository: 21,
        run: 33,
        job,
        status: 'queued',
        runner: null,
        labels: ['boxlite'],
      })),
    )
    const reserve = ExecutionJournal.prototype.reserve
    let reservations = 0
    const reservation = jest.spyOn(ExecutionJournal.prototype, 'reserve').mockImplementation(async function (
      this: ExecutionJournal,
      ...args
    ) {
      if (reservations === 1) {
        entered.resolve()
        await release.promise
      }
      const row = await reserve.apply(this, args)
      if (row) reservations++
      return row
    })
    const create = jest.mocked(backend.workers.create).getMockImplementation()!
    jest.mocked(backend.workers.create).mockImplementation(async (launch) => {
      started.resolve()
      return create(launch)
    })
    listener = new Listener({
      state,
      host: withScanCatalog(host),
      worker: settings,
      capacity: { resolve: async () => testCapacity({ account: 2, tenant: 2 }) },
      timing: { tickMs: 1, leaseMs: 3000 },
    })
    await listener.receive(notification())
    const running = listener.run(abort.signal)
    try {
      await entered.promise
      const outcome = await Promise.race([
        started.promise.then(() => 'started'),
        new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 500)),
      ])
      expect(outcome).toBe('started')
    } finally {
      abort.abort()
      release.resolve()
      await running
      reservation.mockRestore()
    }
  })
  it('plans another scope while the first runner inventory is pending', async () => {
    jest
      .mocked(backend.queued)
      .mockResolvedValue([{ repository: 21, run: 33, job: 55, status: 'queued', runner: null, labels: ['boxlite'] }])
    const entered = deferred(),
      release = deferred(),
      started = deferred()
    const other = structuredClone(scope)
    other.binding = 'other'
    other.installation = { id: 2, account: { id: 8, login: 'other', type: 'User' } }
    other.runners = {
      kind: 'repository',
      repository: { id: 22, owner: { id: 8, login: 'other' }, name: 'repo', private: true },
      allowPrivate: true,
      allowPublic: false,
    }
    let scopes = [scope]
    Object.assign(backend, {
      inventory: jest.fn(async () => {
        entered.resolve()
        await release.promise
        return []
      }),
    })
    const otherBackend = {
      ...backend,
      inventory: async () => [],
      queued: async () => [
        { repository: 22, run: 33, job: 56, status: 'queued' as const, labels: ['boxlite'], runner: null },
      ],
      workers: {
        ...backend.workers,
        create: async (launch: Parameters<typeof backend.workers.create>[0]) => {
          started.resolve()
          return backend.workers.create(launch)
        },
      },
    }
    jest
      .mocked(host.backend)
      .mockImplementation(async (current) => (current.binding === 'other' ? otherBackend : backend))
    jest.mocked(host.discover).mockImplementation(async (owner, _signal, request) => {
      lease = owner
      return { scopes, completed: request.wakes.map((row) => ({ ...row })), pending: false, ready: true }
    })
    jest.mocked(host.scan).mockResolvedValue({ queued: async () => [], publish: async () => {}, close: async () => {} })
    await listener.receive(notification())
    const running = listener.run(abort.signal)
    try {
      await entered.promise
      scopes = [scope, other]
      await listener.receive(notification(56, 2, 8, 22))
      const outcome = await Promise.race([
        started.promise.then(() => 'started'),
        new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 500)),
      ])
      expect(outcome).toBe('started')
    } finally {
      abort.abort()
      release.resolve()
      await running
    }
  })
  it.each(['create', 'jit'] as const)('admits later demand while an earlier %s is pending', async (stage) => {
    const entered = deferred(),
      release = deferred(),
      next = deferred()
    const queued = [{ repository: 21, run: 33, job: 55, status: 'queued' as const, labels: ['boxlite'], runner: null }]
    Object.assign(backend, { inventory: jest.fn(async () => []) })
    jest.mocked(backend.queued).mockImplementation(async () => [...queued])
    const create = jest.mocked(backend.workers.create).getMockImplementation()!
    let creations = 0
    jest.mocked(backend.workers.create).mockImplementation(async (launch) => {
      if (++creations === 1 && stage === 'create') {
        entered.resolve()
        await release.promise
      } else if (creations === 2) next.resolve()
      return create(launch)
    })
    if (stage === 'jit')
      jest.mocked(backend.workers.deliverJit).mockImplementationOnce(async () => {
        entered.resolve()
        await release.promise
      })
    listener = new Listener({
      state,
      host: withScanCatalog(host),
      worker: settings,
      capacity: { resolve: async () => testCapacity({ account: 2, tenant: 2 }) },
      timing: { tickMs: 1, leaseMs: 3000 },
    })
    await listener.receive(notification())
    const running = listener.run(abort.signal)
    try {
      await entered.promise
      queued.push({ ...queued[0], job: 56 })
      await listener.receive(notification(56))
      const outcome = await Promise.race([
        next.promise.then(() => 'started'),
        new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 500)),
      ])
      expect(outcome).toBe('started')
    } finally {
      abort.abort()
      release.resolve()
      await running
    }
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
    expect((await inspectJournal(state, lease)).allocations.size).toBe(0)
  })
})
