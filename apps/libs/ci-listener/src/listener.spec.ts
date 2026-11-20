/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { testCapacity } from '../tests/capacity'
import { createHmac, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionJournal } from './execution/journal'
import { ExecutionScope, decodeScope } from './execution/model'
import { Listener, ListenerBackend, ListenerHost } from './listener'
import { ActionsScaleSets } from './scale-set-client'
import { JitRegistration } from './runners'
import { SqliteStateDatabase } from './state/sqlite'
import { ExecutionLease, ListenerState } from './state/store'
import { ListenerInbox, verifyWebhook } from './webhook'
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
    scanJobs: jest.Mock<Promise<WorkflowJob[]>, [number, AbortSignal]>,
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
    scanJobs = jest.fn(async (_repository: number, _signal: AbortSignal) => [])
    backend = {
      admit: jest.fn(async () => {}),
      scaleSets: new ActionsScaleSets('https://github.com/owner/repo', async () => {
        throw Error('Unavailable')
      }),
      scaleSetAuthority: async () => new Set(['repo']),
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
        queued: (signal: AbortSignal) => scanJobs(claim.repository, signal),
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
  it('persists a verified notification before any scheduler owns the lease and deduplicates a retry', async () => {
    const observe = jest.fn()
    host.observe = observe
    const event = notification()
    expect(await listener.receive(event)).toBe('stored')
    expect(await listener.receive(event)).toBe('duplicate')
    const facts = observe.mock.calls.map(([fact]) => fact)
    expect(facts).toMatchObject(
      ['stored', 'duplicate'].map((result) => ({
        event: 'ci-job-notification',
        jobId: event.hint.job!.id,
        runId: event.hint.job!.runId,
        repositoryId: event.hint.repositoryId,
        status: 'queued',
        result,
      })),
    )
    expect(JSON.stringify(facts)).not.toContain(event.digest)
    const owner = (await state.acquire(randomUUID(), 3000))!
    expect((await state.recover(owner, 1000, ['notice/', 'receipt/'])).map((row) => row.key)).toEqual([
      'notice/1/55',
      'receipt/' + event.delivery,
    ])
    expect(host.backend).not.toHaveBeenCalled()
  })
  it('does not turn a notice for another installation into an authorized job', async () => {
    await listener.receive(notification(55, 9))
    const scanned = deferred()
    jest.mocked(scanJobs).mockImplementation(async () => {
      scanned.resolve()
      return []
    })
    await runUntil(scanned.promise)
    expect(backend.workers.create).not.toHaveBeenCalled()
    expect((await ingressRows()).some((row) => row.key === 'notice/9/55')).toBe(true)
  })
  it('opens another organization when the first backend is unavailable', async () => {
    const available = deferred()
    const first = {
      ...scope,
      binding: 'offline',
      organization: 'other-tenant',
      installation: { ...scope.installation, id: 2 },
    }
    jest.mocked(host.discover).mockResolvedValue({ scopes: [first, scope], completed: [], pending: false, ready: true })
    jest.mocked(host.backend).mockImplementation(async (current) => {
      if (current.binding === first.binding) throw new Error('Scope credentials unavailable')
      available.resolve()
      return backend
    })
    await runUntil(available.promise)
    expect(host.report).toHaveBeenCalledWith(expect.any(Error), 'scope-backend')
  })
  it('releases a closing allocation while repository discovery fails', async () => {
    const journal = new ExecutionJournal(state)
    const released = deferred()
    let seeded = false
    jest.mocked(host.discover).mockImplementation(async (owner) => {
      if (!seeded) {
        const key = await journal.define(owner, scope)
        const row = (await journal.reserve(owner, key, null, testCapacity({ account: 1, tenant: 1 }), {
          labels: ['boxlite'],
          scaleSet: 9,
        }))!
        await journal.advance(owner, row.record.key, row.record.version, { closing: true })
        seeded = true
      }
      throw new Error('Repository discovery unavailable')
    })
    host.observe = (event) => {
      if (event.event === 'ci-worker-released') released.resolve()
    }
    await runUntil(Promise.race([released.promise, new Promise<void>((done) => setTimeout(done, 800))]))
    expect(seeded).toBe(true)
    expect(await journal.used(scope.organization)).toBe(0)
    expect(backend.workers.create).not.toHaveBeenCalled()
  })
  it('retains an undispatched worker when discovery restores its scope during a drain', async () => {
    const journal = new ExecutionJournal(state)
    const restored = deferred()
    const resume = deferred()
    let allocationKey = ''
    let paused = false
    const scan = state.scan.bind(state)
    jest.spyOn(state, 'scan').mockImplementation(async (owner, range) => {
      if (allocationKey && !paused && range.prefix.startsWith('active-worker/')) {
        paused = true
        await resume.promise
      }
      return scan(owner, range)
    })
    jest.mocked(host.discover).mockImplementation(async (owner) => {
      lease = owner
      if (!allocationKey) {
        const key = await journal.define(owner, scope)
        const row = (await journal.reserve(owner, key, null, testCapacity({ account: 1, tenant: 1 }), {
          labels: ['boxlite'],
          scaleSet: 9,
        }))!
        allocationKey = row.record.key
      }
      return { scopes: paused ? [scope] : [], completed: [], pending: true, ready: true }
    })
    backend.scaleSetAuthority = async () => {
      restored.resolve()
      resume.resolve()
      return new Set(['repo'])
    }
    try {
      await runUntil(restored.promise.then(() => new Promise<void>((done) => setTimeout(done, 200))))
    } finally {
      resume.resolve()
    }
    expect(paused).toBe(true)
    expect((await journal.allocation(lease, allocationKey))?.value.closing).toBe(false)
    expect(await journal.used(scope.organization)).toBe(1)
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
    const active = deferred()
    backend.scaleSetAuthority = async () => {
      active.resolve()
      return new Set(['repo'])
    }
    const backendClosed = deferred()
    jest.mocked(backend.close).mockImplementation(async () => backendClosed.resolve())
    const takeover = Promise.all([opening.promise, active.promise]).then(() => replacement.activate())
    const running = listener.run(abort.signal)
    try {
      const result = await Promise.race([
        Promise.all([closed.promise, backendClosed.promise]).then(() => 'closed'),
        new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 500)),
      ])
      expect(result).toBe('closed')
      expect(backend.close).toHaveBeenCalled()
      expect(reader.close).not.toHaveBeenCalled()
      release.resolve()
      await takeover
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
    expect(scanJobs).toHaveBeenCalledTimes(1)
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
})
