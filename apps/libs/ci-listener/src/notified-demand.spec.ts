/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { demandKey, observeDemand } from './demand'
import { ExecutionScope } from './execution/model'
import { WorkflowJob } from './jobs'
import { Listener, ListenerBackend } from './listener'
import { NotifiedDemand } from './notified-demand'
import { SqliteStateDatabase } from './state/sqlite'
import { ListenerState, ExecutionLease } from './state/store'
import { StateConflict } from './state/database'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { resolve, promise }
}

describe('CI notified positive evidence', () => {
  const scope: ExecutionScope = {
    binding: 'binding',
    generation: 1,
    organization: 'tenant',
    actor: 'owner',
    installation: { id: 1, account: { id: 7, login: 'owner', type: 'User' } },
    runners: {
      kind: 'repository',
      repository: { id: 21, owner: { id: 7, login: 'owner' }, name: 'repo', private: true },
      allowPrivate: true,
      allowPublic: false,
    },
  }
  const notice = { repository: 21, run: 33, job: 55 }
  const job: WorkflowJob = { ...notice, status: 'queued', runner: null, labels: ['boxlite'] }
  let directory: string, db: SqliteStateDatabase, state: ListenerState, lease: ExecutionLease, evidence: NotifiedDemand
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'ci-positive-'))
    db = new SqliteStateDatabase(directory)
    state = new ListenerState(db, 'app:' + randomUUID())
    await state.initialize()
    lease = (await state.acquire(randomUUID(), 300000))!
    evidence = new NotifiedDemand(state, lease, ['boxlite'])
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const verify = () => evidence.read(scope, [notice], async () => [job])
  it('removes cached queued evidence when a persisted completion changes its fact', async () => {
    expect(await verify()).toEqual([expect.objectContaining({ queued: 1 })])
    await state.ingress('1/21', async (tx) => {
      await tx.write(
        await observeDemand(
          tx,
          { installationId: 1, accountId: 7, repositoryId: 21, job: { id: 55, runId: 33 } },
          { status: 'completed', runner: null, labels: ['boxlite'] },
        ),
      )
    })
    expect(await evidence.read(scope, [], async () => [])).toEqual([])
    expect(await verify()).toEqual([])
  })
  it('requires another GitHub observation after the positive evidence deadline', async () => {
    let now = Date.now()
    jest.spyOn(Date, 'now').mockImplementation(() => now)
    expect(await verify()).toEqual([expect.objectContaining({ queued: 1 })])
    now += 30000
    expect(await evidence.read(scope, [], async () => [])).toEqual([])
    expect(await verify()).toEqual([expect.objectContaining({ queued: 1 })])
  })
  it.each(['in_progress', 'completed'] as const)(
    'does not count a newly observed %s job as capacity demand',
    async (status) => {
      await verify()
      expect(
        await evidence.read(scope, [notice], async () => [
          { ...job, status, runner: status === 'in_progress' ? 91 : null },
        ]),
      ).toEqual([])
    },
  )
  it.each([{ repository: 22 }, { run: 34 }, { job: 56 }])(
    'rejects a backend response with changed identity %j',
    async (change) => {
      await expect(evidence.read(scope, [notice], async () => [{ ...job, ...change }])).rejects.toThrow(
        'identity changed',
      )
      expect(await evidence.read(scope, [], async () => [])).toEqual([])
    },
  )
  it('ignores notices outside the original repository before invoking the reader', async () => {
    const read = jest.fn(async () => [job])
    expect(await evidence.read(scope, [{ ...notice, repository: 22 }], read)).toEqual([])
    expect(read).not.toHaveBeenCalled()
  })
  it('invalidates positive evidence after a complete background correction', async () => {
    await verify()
    await evidence.invalidate(1, 21)
    expect(await evidence.read(scope, [], async () => [])).toEqual([])
  })
  it('does not renew evidence that aged while GitHub lookups were pending', async () => {
    let now = Date.now()
    jest.spyOn(Date, 'now').mockImplementation(() => now)
    expect(
      await evidence.read(scope, [notice], async () => {
        now += 31000
        return [job]
      }),
    ).toEqual([])
  })
  it('rejects a read begun before invalidation and permits a new observation', async () => {
    let entered!: () => void, release!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const reading = evidence.read(scope, [notice], async () => {
      entered()
      await held
      return [job]
    })
    const rejected = expect(reading).rejects.toBeInstanceOf(StateConflict)
    await started
    await evidence.invalidate(1, 21)
    release()
    await rejected
    expect(await state.read(['job-fact/1/55'], lease)).toEqual([])
    expect(await evidence.read(scope, [], async () => [])).toEqual([])
    expect(await verify()).toEqual([expect.objectContaining({ queued: 1 })])
  })
  it('fences cached demand while a committed snapshot correction is still completing', async () => {
    await verify()
    const otherScope: ExecutionScope = {
      ...scope,
      runners: {
        ...scope.runners,
        kind: 'repository',
        repository: { id: 22, owner: { id: 7, login: 'owner' }, name: 'other', private: true },
      },
    }
    const otherNotice = { repository: 22, run: 34, job: 56 }
    await evidence.read(otherScope, [otherNotice], async () => [{ ...job, ...otherNotice }])
    const committed = deferred(),
      release = deferred(),
      ingress = state.ingress.bind(state)
    let paused = false
    jest.spyOn(state, 'ingress').mockImplementation(async (...args) => {
      const result = await ingress(...args)
      if (args[0] === '1/21' && !paused) {
        paused = true
        committed.resolve()
        await release.promise
      }
      return result
    })
    const listener = new Listener({
      state,
      worker: { image: 'runner-test', cpus: 2, memoryMiB: 2048, labels: ['boxlite'] },
      capacity: {
        resolve: async () => {
          throw new Error('Unexpected capacity lookup')
        },
      },
      host: {
        discover: async () => {
          throw new Error('Unexpected discovery')
        },
        backend: async () => {
          throw new Error('Unexpected backend lookup')
        },
        scan: async () => {
          throw new Error('Unexpected compensation scan')
        },
        accept: async () => {
          throw new Error('Unexpected webhook')
        },
        report: () => {},
      },
    })
    // Invoke the production scan path without starting unrelated scheduling owners.
    const scanning = (
      listener as unknown as {
        scanRepository(
          session: { lease: ExecutionLease; positive: NotifiedDemand; verifiedAt: Map<string, never> },
          key: string,
          scope: ExecutionScope,
          runtime: { backend: Pick<ListenerBackend, 'queued' | 'close'> },
          repository: number,
          signal: AbortSignal,
        ): Promise<unknown>
      }
    ).scanRepository(
      { lease, positive: evidence, verifiedAt: new Map<string, never>() },
      'scope',
      scope,
      { backend: { queued: async () => [], close: async () => {} } },
      21,
      new AbortController().signal,
    )
    let cached: ReturnType<NotifiedDemand['read']> | undefined, fresh: ReturnType<NotifiedDemand['read']> | undefined
    const observed = deferred(),
      freshNotice = { ...notice, job: 57 }
    try {
      await committed.promise
      const [revision, count] = await state.read(['queue-revision/1/21', demandKey(1, 21, ['boxlite'])], lease)
      expect(count.payload).toEqual(expect.objectContaining({ queued: 0 }))
      expect((await state.read(['job-fact/1/55'], lease))[0].payload).toEqual(
        expect.objectContaining({ status: 'queued' }),
      )
      cached = evidence.read(scope, [], async () => [])
      let beforeCompletion: Awaited<ReturnType<NotifiedDemand['read']>> = []
      void cached.then((demands) => {
        beforeCompletion = demands
      })
      fresh = evidence.read(scope, [freshNotice], async () => {
        observed.resolve()
        return [{ ...job, ...freshNotice }]
      })
      await observed.promise
      let freshSettled = false
      void fresh.then(() => {
        freshSettled = true
      })
      expect(await evidence.read(otherScope, [], async () => [])).toEqual([
        expect.objectContaining({ repositoryId: 22, queued: 1 }),
      ])
      // SQLite's synchronous operations drain before this event-loop boundary.
      await setImmediate()
      expect(beforeCompletion).toEqual([])
      expect(freshSettled).toBe(false)
      expect(revision.key).toBe('queue-revision/1/21')
    } finally {
      release.resolve()
      await scanning
    }
    expect(await cached).toEqual([])
    expect(await fresh).toEqual([expect.objectContaining({ queued: 1, job: { id: 57, runId: 33 } })])
    expect(await evidence.read(scope, [], async () => [])).toEqual([
      expect.objectContaining({ queued: 1, job: { id: 57, runId: 33 } }),
    ])
  })
  it('propagates a correction failure and releases its repository for fresh evidence', async () => {
    await verify()
    const failure = new Error('Snapshot correction failed')
    await expect(
      evidence.invalidate(1, 21, async () => {
        await state.read(['queue-revision/1/21'], lease)
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(await evidence.read(scope, [], async () => [])).toEqual([])
    expect(await verify()).toEqual([expect.objectContaining({ queued: 1 })])
  })
})
