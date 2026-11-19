/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { inspectJournal } from '../../tests/journal'
import { testCapacity } from '../../tests/capacity'
import { executeWorkerBootstrap } from '../../tests/worker-bootstrap'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JitRegistration, RunnerIdentity, RunnerObservation } from '../runners'
import { LeaseLost, StateConflict, StateCorrupt } from '../state/database'
import { ExecutionLease, ListenerState } from '../state/store'
import { SqliteStateDatabase } from '../state/sqlite'
import { ConfirmedWorkerAbsent, ConfirmedWorkerCreationRejected, WorkerState } from '../worker'
import { ExecutionJournal } from './journal'
import { ExecutionScope } from './model'
import { PoolBackend, WorkerPool } from './pool'
import { WorkQueue } from './work-queue'
import { decodeDemand, DemandUncertain, observeDemand, rebuildQueueSnapshot } from '../demand'

describe('CI shared worker lifecycle', () => {
  const definition: ExecutionScope = {
    binding: 'binding-a',
    generation: 1,
    organization: 'tenant-a',
    actor: 'owner-a',
    installation: { id: 1, account: { id: 7, login: 'owner', type: 'User' } },
    runners: {
      kind: 'repository',
      repository: { id: 21, owner: { id: 7, login: 'owner' }, name: 'repo', private: true },
      allowPrivate: true,
      allowPublic: false,
    },
  }
  const demand = { repository: 21, run: 33, job: 55 },
    limits = testCapacity({ account: 1, tenant: 1 })
  const settings = {
    image: 'official-runner-test',
    cpus: 2,
    memoryMiB: 2048,
    labels: ['self-hosted', 'linux', 'x64', 'boxlite'],
  }
  let directory: string,
    db: SqliteStateDatabase,
    state: ListenerState,
    journal: ExecutionJournal,
    lease: ExecutionLease,
    key: string,
    pool: WorkerPool,
    backend: PoolBackend
  let boxes: Map<string, WorkerState>, known: Set<string>, runners: Map<string, RunnerIdentity>, nextRunner: number
  let loseBox: boolean,
    loseRunner: boolean,
    materializeBox: boolean,
    materializeRunner: boolean,
    loseDelivery: boolean,
    busyRunner: boolean,
    closeFailures: number
  let events: unknown[], observe: jest.Mock
  const rows = async () => inspectJournal(state, lease)
  const allocation = async () => [...(await rows()).allocations.values()][0]
  const byName = async (name: string) =>
    [...(await rows()).allocations.values()].find((row) => row.value.name === name)!
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'ci-pool-'))
    db = new SqliteStateDatabase(directory)
    state = new ListenerState(db, 'app:' + randomUUID())
    journal = new ExecutionJournal(state)
    await journal.initialize()
    lease = (await state.acquire(randomUUID(), 300000))!
    key = await journal.define(lease, definition)
    boxes = new Map()
    known = new Set()
    runners = new Map()
    nextRunner = 90
    loseBox = false
    loseRunner = false
    materializeBox = true
    materializeRunner = true
    loseDelivery = false
    busyRunner = false
    closeFailures = 0
    events = []
    observe = jest.fn((event: unknown) => events.push(event))
    backend = {
      admit: jest.fn(async () => {}),
      job: jest.fn(async (notice) => ({
        ...notice,
        status: 'queued' as const,
        labels: ['boxlite'],
        runner: null,
      })),
      workers: {
        create: jest.fn(async (launch) => {
          const current = await byName(launch.name)
          expect(current.value.box.phase).toBe('requested')
          expect(current.value.effect?.kind).toBe('box-create')
          const result = { box_id: 'box-' + randomUUID(), status: 'running' }
          if (materializeBox) {
            boxes.set(launch.name, result)
            known.add(launch.name)
          }
          if (loseBox) throw new Error('lost Box response')
          return { ...result }
        }),
        get: jest.fn(async (name) => {
          const box = boxes.get(name)
          if (box) return { ...box }
          if (known.has(name)) throw new ConfirmedWorkerAbsent()
          throw new Error('unknown Box create outcome')
        }),
        stop: jest.fn(async (name) => {
          expect((await byName(name)).value.effect?.kind).toBe('box-stop')
          boxes.get(name)!.status = 'stopped'
        }),
        remove: jest.fn(async (name) => {
          expect((await byName(name)).value.effect?.kind).toBe('box-remove')
          boxes.delete(name)
        }),
        deliverJit: jest.fn(async (name, configuration) => {
          expect((await byName(name)).value.delivery).toBe('requested')
          expect((await byName(name)).value.effect?.kind).toBe('jit-deliver')
          expect(boxes.has(name)).toBe(true)
          expect(configuration).toBe('c2VjcmV0')
          if (loseDelivery) throw new Error('lost upload acknowledgement')
        }),
      },
      runners: jest.fn(async (guard) => ({
        registry: {
          create: jest.fn(async (name) => {
            await guard({ kind: 'register', name })
            expect((await byName(name)).value.runner.phase).toBe('requested')
            const identity = { id: ++nextRunner, name }
            if (materializeRunner) runners.set(name, identity)
            if (loseRunner) throw new Error('lost JIT response')
            return new JitRegistration(identity, 'c2VjcmV0')
          }),
          lookup: jest.fn(async (identity) => {
            const found = runners.get(identity.name)
            return found && (identity.id === undefined || found.id === identity.id) ? { ...found } : null
          }),
          remove: jest.fn(async (identity) => {
            await guard({ kind: 'remove', ...identity })
            expect((await byName(identity.name)).value.effect?.kind).toBe('runner-remove')
            if (busyRunner) throw new Error('GitHub runner is busy')
            runners.delete(identity.name)
          }),
        },
        close: jest.fn(async () => {
          if (closeFailures-- > 0) throw new Error('token retirement pending')
        }),
      })),
    }
    pool = new WorkerPool(journal, key, async () => backend, settings, observe)
  })
  afterEach(async () => {
    await pool.close().catch(() => {})
    await db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const tick = (notice: typeof demand | undefined = demand) => pool.tick(lease, limits, notice)
  const reconcile = () => pool.tick(lease, limits)
  const finishBox = async () => {
    for (const box of boxes.values()) box.status = 'stopped'
    await reconcile()
    await reconcile()
  }
  const customJob = (labels = ['boxlite-2vcpu-4gbmem-10gbdisk']) => {
    jest
      .mocked(backend.job)
      .mockImplementation(async (notice) => ({ ...notice, status: 'queued', labels, runner: null }))
  }
  const countedDemand = (queued = 1, labels = ['boxlite']) => [
    {
      installationId: 1,
      accountId: 7,
      repositoryId: 21,
      labels,
      queued,
      dirty: false,
      updatedAt: Date.now(),
      job: { id: demand.job, runId: demand.run },
    },
  ]
  it.each(['delayed', 'install-success'])(
    'Docker bootstrap waits for the API before runner startup: %s',
    async (scenario) => {
      await tick()
      const launch = jest.mocked(backend.workers.create).mock.calls[0][0]
      const result = executeWorkerBootstrap(launch.entrypoint, directory, scenario)
      expect(result.trace.at(-1)).toBe('runner:ready')
      expect(result.status).toBe(0)
      expect(result.trace).toContain('dockerd')
      expect(result.jit).toBe('dGVzdC1qaXQ=')
      expect(result.jitRemoved).toBe(true)
      expect(result.dockerEnvironment).toEqual([join(directory, 'runner'), 'runner', 'runner'])
      expect(result.runnerEnvironment).toEqual(result.dockerEnvironment)
      if (scenario === 'install-success') expect(result.trace).toContain('apt-get:install')
    },
  )
  it.each(['crash', 'timeout', 'install-failure', 'missing-jit'])(
    'Docker bootstrap fails before runner execution: %s',
    async (scenario) => {
      await tick()
      const launch = jest.mocked(backend.workers.create).mock.calls[0][0]
      const result = executeWorkerBootstrap(launch.entrypoint, directory, scenario)
      expect(result.status).not.toBe(0)
      expect(result.trace.some((line) => line.startsWith('runner:'))).toBe(false)
      if (scenario === 'crash') expect(result.stderr).toContain('fixture-daemon-failed')
      if (scenario === 'missing-jit') {
        expect(result.trace).toContain('dockerd')
        expect(result.daemonRunning).toBe(false)
      }
    },
  )
  it('Docker bootstrap reuses an existing daemon without starting another', async () => {
    await tick()
    const launch = jest.mocked(backend.workers.create).mock.calls[0][0]
    const result = executeWorkerBootstrap(launch.entrypoint, directory, 'existing')
    expect(result.status).toBe(0)
    expect(result.trace.at(-1)).toBe('runner:ready')
    expect(result.trace).not.toContain('dockerd')
  })
  it('rotates past an allocation in retry backoff on the next capacity plan', async () => {
    const policy = testCapacity({ account: 2, tenant: 2 })
    await pool.tick(lease, policy, demand)
    await pool.tick(lease, policy, { ...demand, job: 56 })
    await pool.close()
    supplyInventory()
    const [first, second] = (await journal.workers(lease, key)).rows
    const queue = new WorkQueue(2, () => {})
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now())
    queue.enqueue(first.record.key, 'failed', async () => {
      throw new Error('retry later')
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    let continued = false
    const get = jest.mocked(backend.workers.get).getMockImplementation()!
    jest.mocked(backend.workers.get).mockImplementation(async (...args) => {
      if (args[0] === second.value.name) continued = true
      return get(...args)
    })
    pool = new WorkerPool(journal, key, async () => backend, settings, observe, { queue, wake: () => {} })
    try {
      await pool.balance(lease, policy, [])
      await pool.balance(lease, policy, [])
      await queue.close()
      expect(continued).toBe(true)
    } finally {
      clock.mockRestore()
      await queue.close()
    }
  })
  const supplyInventory = (busy = new Set<string>()) => {
    const inventory = jest.fn(
      async (): Promise<RunnerObservation[]> =>
        [...runners.values()].map((runner) => ({
          ...runner,
          busy: busy.has(runner.name),
          status: 'online' as const,
          labels: [...settings.labels],
        })),
    )
    Object.assign(backend, { inventory })
    return inventory
  }
  const idleRetirement = (result: boolean | Error = true, beforeDelete?: () => Promise<void>) => {
    const open = backend.runners
    const retire = jest.fn(
      async (identity: RunnerIdentity, guard: Parameters<PoolBackend['runners']>[0], check?: () => void) => {
        await guard({ kind: 'remove', ...identity })
        expect((await byName(identity.name)).value.effect?.kind).toBe('runner-retire')
        await beforeDelete?.()
        check?.()
        if (result instanceof Error) throw result
        if (result) runners.delete(identity.name)
        return result
      },
    )
    backend.runners = jest.fn(async (...args: Parameters<PoolBackend['runners']>) => {
      const session = await open(...args)
      Object.assign(session.registry, {
        retireIdle: (identity: RunnerIdentity, _signal?: AbortSignal, check?: () => void) =>
          retire(identity, args[0], check),
      })
      return session
    })
    return retire
  }
  const ageRunners = async () => {
    for (const row of (await rows()).allocations.values())
      await journal.advance(lease, row.record.key, row.record.version, {
        runner: { ...row.value.runner, registeredAt: Date.now() - 301000 },
      })
  }
  const organizationDemand = async (count: number) => {
    const repositories = Array.from({ length: count }, (_, index) => index + 21)
    key = await journal.define(lease, {
      ...definition,
      installation: { id: 1, account: { id: 7, login: 'owner', type: 'Organization' } },
      runners: {
        kind: 'organization',
        account: { id: 7, login: 'owner' },
        group: 5,
        repositories,
        allowPrivate: true,
        allowPublic: false,
      },
    })
    pool = new WorkerPool(journal, key, async () => backend, settings, observe)
    for (const repositoryId of repositories)
      await state.ingress(`1/${repositoryId}`, async (tx) => {
        await tx.write(
          await observeDemand(
            tx,
            { installationId: 1, accountId: 7, repositoryId, job: { id: repositoryId + 1000, runId: demand.run } },
            { status: 'queued', labels: ['boxlite'], runner: null },
          ),
        )
      })
  }
  const durableDemands = async () =>
    (await state.recover(lease, 1000, ['demand/'])).map(decodeDemand).sort((a, b) => a.repositoryId - b.repositoryId)
  it('keeps live idle runners when only partial positive demand was verified', async () => {
    supplyInventory()
    const retire = idleRetirement()
    await tick()
    await ageRunners()
    await pool.balance(lease, limits, [], undefined, 'positive' as never)
    expect(retire).not.toHaveBeenCalled()
    expect(backend.workers.stop).not.toHaveBeenCalled()
    expect(runners.size).toBe(1)
  })
  it('keeps unsent reservations when a positive subset or an oversized proof cannot establish surplus', async () => {
    supplyInventory()
    const capacity = testCapacity({ account: 2, tenant: 2 })
    await journal.reserve(lease, key, demand, capacity, { labels: settings.labels })
    await journal.reserve(lease, key, { ...demand, job: 56 }, capacity, { labels: settings.labels })
    const queue = new WorkQueue(1, () => {})
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    queue.enqueue('held', '1', () => held)
    pool = new WorkerPool(journal, key, async () => backend, settings, observe, { queue, wake: () => {} })
    try {
      await pool.balance(lease, capacity, countedDemand(), undefined, 'positive')
      expect(await journal.used(definition.organization)).toBe(2)
      const guards = []
      for (let first = 0; first < 101; first += 50) {
        const records = await state.commit(
          lease,
          Array.from({ length: Math.min(50, 101 - first) }, (_, index) => ({
            key: 'proof/' + (first + index),
            expected: null,
            payload: true,
          })),
        )
        guards.push(...records.map((row) => ({ key: row.key, version: row.version })))
      }
      await pool.balance(lease, capacity, [], undefined, true, guards)
      expect(await journal.used(definition.organization)).toBe(2)
      expect((await journal.workers(lease, key)).rows.every((row) => !row.value.closing)).toBe(true)
    } finally {
      release()
      await queue.close()
    }
  })
  it.each([false, true])(
    'limits retained unsent reservations to verified queued demand (async=%s)',
    async (asynchronous) => {
      supplyInventory()
      const capacity = testCapacity({ account: 2, tenant: 2 })
      await journal.reserve(lease, key, demand, capacity, { labels: settings.labels })
      await journal.reserve(lease, key, { ...demand, job: 56 }, capacity, { labels: settings.labels })
      const failures: unknown[] = []
      const queue = new WorkQueue(1, (error) => failures.push(error))
      let release!: () => void, completed!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const finished = new Promise<void>((resolve) => {
        completed = resolve
      })
      if (asynchronous) {
        queue.enqueue('barrier', '1', () => held)
        pool = new WorkerPool(journal, key, async () => backend, settings, observe, { queue, wake: () => {} })
      }
      try {
        await pool.balance(lease, capacity, countedDemand(), undefined, 'positive')
        if (asynchronous) {
          queue.enqueue('after-dispatch', '1', async () => completed())
          release()
          await finished
        }
        expect(failures).toEqual([])
        expect(backend.workers.create).toHaveBeenCalledTimes(1)
        expect(await journal.used(definition.organization)).toBe(2)
        const retained = (await journal.workers(lease, key)).rows
        expect(retained).toHaveLength(2)
        expect(retained.every((row) => !row.value.closing)).toBe(true)
      } finally {
        release()
        await queue.close()
      }
    },
  )
  it.each(['single', 'queued', 'committed during read'])(
    'preserves an accepted create after backoff: %s',
    async (stage) => {
      supplyInventory()
      const capacity = testCapacity({ account: 2, tenant: 2 })
      await journal.reserve(lease, key, demand, capacity, { labels: settings.labels })
      await journal.reserve(lease, key, { ...demand, job: 56 }, capacity, { labels: settings.labels })
      const [first, second] = (await journal.workers(lease, key)).rows
      const rejected = new Error('retry this reservation later')
      const failures: unknown[] = []
      const queue = new WorkQueue(1, (error) => failures.push(error))
      const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now())
      let failed!: () => void, release!: () => void, completed!: () => void
      const backoffReady = new Promise<void>((resolve) => {
        failed = resolve
      })
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const finished = new Promise<void>((resolve) => {
        completed = resolve
      })
      queue.enqueue(first.record.key, 'failed', async () => {
        throw rejected
      })
      queue.enqueue('after-failure', '1', async () => failed())
      await backoffReady
      queue.enqueue('barrier', '1', () => held)
      const enqueue = jest.spyOn(queue, 'enqueue')
      pool = new WorkerPool(journal, key, async () => backend, settings, observe, { queue, wake: () => {} })
      try {
        await pool.balance(lease, capacity, countedDemand(), undefined, 'positive')
        if (stage !== 'single') {
          if (stage === 'committed during read') {
            const list = journal.workers.bind(journal)
            jest.spyOn(journal, 'workers').mockImplementationOnce(async (...args) => {
              const page = await list(...args)
              const drained = new Promise<void>((done) => {
                queue.enqueue('intent-settled', '1', async () => done())
              })
              release()
              await drained
              return page
            })
          }
          clock.mockReturnValue(Date.now() + 1001)
          await pool.balance(lease, capacity, countedDemand(), undefined, 'positive')
        }
        queue.enqueue('after-dispatch', '1', async () => completed())
        release()
        await finished
        expect(failures).toEqual([rejected])
        expect(backend.workers.create).toHaveBeenCalledTimes(1)
        expect(backend.workers.create).toHaveBeenCalledWith(expect.objectContaining({ name: second.value.name }))
        expect(enqueue.mock.calls.filter(([key]) => key === first.record.key)).toHaveLength(1)
        if (stage === 'single') expect(enqueue.mock.calls.filter(([key]) => key === second.record.key)).toHaveLength(2)
        expect(await journal.used(definition.organization)).toBe(2)
        expect((await journal.workers(lease, key)).rows.every((row) => !row.value.closing)).toBe(true)
      } finally {
        release()
        await queue.close()
        clock.mockRestore()
      }
    },
  )
  it.each([false, true])(
    'keeps retained unsent reservations unissued when started supply covers demand (async=%s)',
    async (asynchronous) => {
      supplyInventory()
      const capacity = testCapacity({ account: 3, tenant: 3 })
      await pool.balance(lease, capacity, countedDemand(), undefined, 'positive')
      await pool.close()
      await journal.reserve(lease, key, { ...demand, job: 56 }, capacity, { labels: settings.labels })
      await journal.reserve(lease, key, { ...demand, job: 57 }, capacity, { labels: settings.labels })
      jest.mocked(backend.workers.create).mockClear()
      const failures: unknown[] = []
      const queue = new WorkQueue(1, (error) => failures.push(error))
      let release!: () => void, completed!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const finished = new Promise<void>((resolve) => {
        completed = resolve
      })
      if (asynchronous) {
        queue.enqueue('barrier', '1', () => held)
        pool = new WorkerPool(journal, key, async () => backend, settings, observe, { queue, wake: () => {} })
      }
      try {
        await pool.balance(lease, capacity, countedDemand(), undefined, 'positive')
        if (asynchronous) {
          queue.enqueue('after-dispatch', '1', async () => completed())
          release()
          await finished
        }
        expect(failures).toEqual([])
        expect(backend.workers.create).not.toHaveBeenCalled()
        expect(await journal.used(definition.organization)).toBe(3)
        const retained = (await journal.workers(lease, key)).rows
        expect(retained).toHaveLength(3)
        expect(retained.every((row) => !row.value.closing)).toBe(true)
      } finally {
        release()
        await queue.close()
      }
    },
  )
  it('refreshes positive demand once per newly unclaimed busy runner before replacing its supply', async () => {
    const busy = new Set<string>()
    supplyInventory(busy)
    const capacity = testCapacity({ account: 3, tenant: 3 })
    await pool.balance(lease, capacity, countedDemand(), undefined, 'positive')
    const first = await allocation()
    busy.add(first.value.name)
    await expect(pool.balance(lease, capacity, countedDemand(), undefined, 'positive')).rejects.toMatchObject({
      requiresJobRefresh: true,
    })
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
    await pool.balance(lease, capacity, countedDemand(), undefined, 'positive')
    expect(backend.workers.create).toHaveBeenCalledTimes(2)
    busy.clear()
    await pool.balance(lease, capacity, countedDemand(), undefined, 'positive')
    for (const runner of runners.values()) busy.add(runner.name)
    await expect(pool.balance(lease, capacity, countedDemand(), undefined, 'positive')).rejects.toMatchObject({
      requiresJobRefresh: true,
    })
    expect(backend.workers.create).toHaveBeenCalledTimes(2)
    expect(backend.workers.stop).not.toHaveBeenCalled()
  })
  it.each([false, true])(
    'refreshes complete queue evidence before replacing newly unclaimed busy supply (reserved=%s)',
    async (reserved) => {
      const busy = new Set<string>()
      supplyInventory(busy)
      const capacity = testCapacity({ account: 2, tenant: 2 })
      const snapshot = await rebuildQueueSnapshot(
        state,
        lease,
        { installationId: 1, accountId: 7, repositoryId: 21 },
        [],
        [await backend.job(demand)],
      )
      const demands = snapshot.demands.map(decodeDemand)
      const checks = [{ key: snapshot.revision.key, version: snapshot.revision.version }]
      await pool.balance(lease, capacity, demands, undefined, true, checks)
      const first = await allocation()
      if (reserved) await journal.reserve(lease, key, { ...demand, job: 56 }, capacity, { labels: settings.labels })
      busy.add(first.value.name)
      jest.mocked(backend.job).mockImplementation(async (notice) => ({
        ...notice,
        status: 'in_progress',
        labels: ['boxlite'],
        runner: first.value.runner.id,
      }))
      await expect(pool.balance(lease, capacity, demands, undefined, true, checks)).rejects.toMatchObject({
        requiresJobRefresh: true,
      })
      expect(backend.workers.create).toHaveBeenCalledTimes(1)
      expect(await journal.used(definition.organization)).toBe(reserved ? 2 : 1)
    },
  )
  it('admits PAT queue demand up to the configured single slot', async () => {
    supplyInventory()
    key = await journal.define(lease, { ...definition, installation: { ...definition.installation, id: 0 } })
    pool = new WorkerPool(journal, key, async () => backend, settings, observe)
    const snapshot = await rebuildQueueSnapshot(
      state,
      lease,
      { installationId: 0, accountId: 7, repositoryId: 21 },
      [],
      [await backend.job(demand), await backend.job({ ...demand, job: 56 })],
    )
    await pool.balance(lease, limits, snapshot.demands.map(decodeDemand), undefined, true, [
      { key: snapshot.revision.key, version: snapshot.revision.version },
    ])
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
    expect(await journal.used(definition.organization)).toBe(1)
  })
  it('dispatches an existing unsent allocation before waiting for another reservation', async () => {
    supplyInventory()
    const capacity = testCapacity({ account: 2, tenant: 2 })
    const reserved = (await journal.reserve(lease, key, demand, capacity, { labels: settings.labels }))!
    const queue = new WorkQueue(2, () => {})
    pool = new WorkerPool(journal, key, async () => backend, settings, observe, { queue, wake: () => {} })
    let entered!: () => void, release!: () => void, created!: () => void
    const waiting = new Promise<void>((resolve) => {
      entered = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const dispatched = new Promise<void>((resolve) => {
      created = resolve
    })
    const reserve = journal.reserve.bind(journal)
    const spy = jest.spyOn(journal, 'reserve').mockImplementation(async (...args) => {
      entered()
      await held
      return reserve(...args)
    })
    const create = jest.mocked(backend.workers.create).getMockImplementation()!
    jest.mocked(backend.workers.create).mockImplementation(async (launch) => {
      const box = await create(launch)
      if (launch.name === reserved.value.name) created()
      return box
    })
    const planning = pool.balance(lease, capacity, countedDemand(2), undefined, 'positive')
    try {
      await waiting
      await Promise.race([
        dispatched,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Existing reservation blocked')), 1000)),
      ])
      expect(backend.workers.create).toHaveBeenCalledWith(expect.objectContaining({ name: reserved.value.name }))
    } finally {
      release()
      await planning
      await queue.close()
      spy.mockRestore()
    }
  })
  it('rechecks a queue proof deadline after retirement waits in the execution queue', async () => {
    supplyInventory()
    idleRetirement()
    await tick()
    await ageRunners()
    const [proof] = await state.commit(lease, [{ key: 'queue-revision/1/21', expected: null, payload: true }])
    await pool.close()
    let release!: () => void, completed!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const finished = new Promise<void>((resolve) => {
      completed = resolve
    })
    const queue = new WorkQueue(1, () => {})
    queue.enqueue('barrier', '1', () => held)
    pool = new WorkerPool(journal, key, async () => backend, settings, observe, { queue, wake: () => {} })
    const now = Date.now(),
      clock = jest.spyOn(Date, 'now').mockReturnValue(now)
    try {
      await pool.balance(lease, limits, [], undefined, true, [
        Object.assign({ key: proof.key, version: proof.version }, { expiresAt: now + 100 }),
      ])
      queue.enqueue('after-retirement', '1', async () => completed())
      clock.mockReturnValue(now + 101)
      release()
      await finished
      expect(runners.size).toBe(1)
      expect(backend.workers.stop).not.toHaveBeenCalled()
      expect((await allocation()).value.effect?.kind).not.toBe('runner-retire')
    } finally {
      release()
      await queue.close()
      clock.mockRestore()
    }
  })
  it('recovers a stopped Box even when complete retirement proof exceeds 100 checks', async () => {
    supplyInventory()
    const retire = idleRetirement()
    await tick()
    await ageRunners()
    for (const box of boxes.values()) box.status = 'stopped'
    const checks = []
    for (let offset = 0; offset < 101; offset += 100) {
      const rows = await state.commit(
        lease,
        Array.from({ length: Math.min(100, 101 - offset) }, (_, index) => ({
          key: `queue-revision/1/${offset + index + 21}`,
          expected: null,
          payload: true,
        })),
      )
      checks.push(...rows.map(({ key, version }) => ({ key, version })))
    }
    await pool.close()
    const queue = new WorkQueue(1, () => {})
    pool = new WorkerPool(journal, key, async () => backend, settings, observe, { queue, wake: () => {} })
    try {
      await pool.balance(lease, limits, [], undefined, true, checks)
      await queue.close()
    } finally {
      await queue.close()
    }
    expect(retire).not.toHaveBeenCalled()
    expect(backend.workers.remove).toHaveBeenCalledTimes(1)
  })
  it('requires an authoritative queue snapshot before expanding counted supply', async () => {
    supplyInventory()
    await expect(pool.balance(lease, limits, countedDemand())).rejects.toBeInstanceOf(DemandUncertain)
    expect(backend.workers.create).not.toHaveBeenCalled()
    await pool.balance(lease, limits, countedDemand(), undefined, true)
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
  })
  it('retires surplus online idle runners before stopping their original Boxes', async () => {
    supplyInventory()
    const retireIdle = idleRetirement()
    await pool.balance(lease, limits, countedDemand(), undefined, true)
    await ageRunners()
    await pool.balance(lease, limits, countedDemand(0), undefined, true)
    expect(retireIdle).toHaveBeenCalledTimes(1)
    expect(backend.workers.stop).toHaveBeenCalledTimes(1)
    expect(await journal.hasCapacity(lease, key, limits)).toBe(false)
    await pool.balance(lease, limits, countedDemand(0), undefined, true)
    await pool.balance(lease, limits, countedDemand(0), undefined, true)
    expect(await journal.hasCapacity(lease, key, limits)).toBe(true)
    expect((await rows()).allocations.size).toBe(0)
  })
  it.each([
    'ordinary',
    'needed',
    'positive needed',
    'positive partial',
    'positive empty',
    'positive active',
    'positive replacement',
    'stale',
  ])('rechecks a pending retirement when the next plan is %s', async (next) => {
    const active = next === 'positive active' || next === 'positive replacement'
    const busy = new Set<string>()
    supplyInventory(busy)
    let release!: () => void
    const barrier = new Promise<void>((done) => {
      release = done
    })
    let started!: () => void
    const entered = new Promise<void>((done) => {
      started = done
    })
    idleRetirement(
      true,
      active
        ? async () => {
            started()
            await barrier
          }
        : undefined,
    )
    const remove = jest.spyOn(runners, 'delete')
    const workers = next === 'positive partial' ? 2 : 1
    const capacity = testCapacity({ account: active ? 2 : workers, tenant: active ? 2 : workers })
    await pool.balance(lease, capacity, countedDemand(workers), undefined, true)
    await ageRunners()
    const [fence] = await state.commit(lease, [{ key: 'proof/idle', expected: null, payload: true }])
    const errors: unknown[] = []
    const queue = new WorkQueue(1, (error) => errors.push(error))
    if (!active) queue.enqueue('hold', '1', () => barrier)
    pool = new WorkerPool(journal, key, async () => backend, settings, observe, { queue, wake: () => {} })
    try {
      await pool.balance(lease, capacity, [], undefined, true, [{ key: fence.key, version: fence.version }])
      if (active) await entered
      if (next.startsWith('positive')) {
        await pool.balance(lease, capacity, next === 'positive empty' ? [] : countedDemand(), undefined, 'positive')
      } else if (next === 'needed') {
        await pool.balance(lease, capacity, countedDemand(), undefined, true, [
          { key: fence.key, version: fence.version },
        ])
      } else {
        if (next === 'stale') {
          await state.commit(lease, [{ key: fence.key, expected: fence.version, payload: false }])
        }
        await pool.balance(lease, capacity, [], undefined).catch((error: unknown) => {
          if (!(error instanceof DemandUncertain)) throw error
        })
      }
      if (next === 'positive replacement') {
        await state.commit(lease, [{ key: fence.key, expected: fence.version, payload: false }])
        await pool.balance(lease, capacity, [], undefined, true, [{ key: fence.key, version: fence.version }])
      }
      const drained = new Promise<void>((done) => {
        queue.enqueue('drain', '1', async () => done())
      })
      release()
      await drained
      const retired = next === 'ordinary' || next === 'positive empty' || next === 'positive partial'
      expect(backend.workers.stop).toHaveBeenCalledTimes(retired ? 1 : 0)
      expect(runners.size).toBe(workers - (retired ? 1 : 0))
      expect(remove).toHaveBeenCalledTimes(retired ? 1 : 0)
      expect(errors).toEqual(next === 'stale' || active ? [expect.any(StateConflict)] : [])
      if (next === 'positive active') {
        busy.add((await allocation()).value.name)
        await expect(pool.balance(lease, capacity, countedDemand(), undefined, 'positive')).rejects.toBeInstanceOf(
          DemandUncertain,
        )
        expect(backend.workers.create).toHaveBeenCalledTimes(1)
        expect((await allocation()).value.effect?.kind).not.toBe('runner-retire')
      }
    } finally {
      release()
      await queue.close()
    }
  })
  it('recovers surplus idle capacity after a lost JIT acknowledgement and restart', async () => {
    supplyInventory()
    const retire = idleRetirement()
    loseDelivery = true
    await pool.balance(lease, limits, countedDemand(), undefined, true)
    expect((await allocation()).value.delivery).toBe('requested')
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ errorType: 'Error' }))
    await ageRunners()
    await pool.close()
    pool = new WorkerPool(journal, key, async () => backend, settings, observe)
    const unverified = await pool.balance(lease, limits, []).catch((error) => error)
    expect(retire).not.toHaveBeenCalled()
    await pool.balance(lease, limits, [], undefined, true)
    expect(retire).toHaveBeenCalledTimes(1)
    expect(unverified).toBeInstanceOf(DemandUncertain)
    expect((await allocation()).value).toMatchObject({ delivery: 'requested', closing: true })
    expect(backend.workers.stop).toHaveBeenCalledTimes(1)
    expect(await journal.hasCapacity(lease, key, limits)).toBe(false)
    await pool.balance(lease, limits, [], undefined, true)
    await pool.balance(lease, limits, [], undefined, true)
    expect(await journal.used(definition.organization)).toBe(0)
    expect((await rows()).allocations.size).toBe(0)
    expect(backend.workers.deliverJit).toHaveBeenCalledTimes(1)
  })
  it('preserves startup, busy and queue protections after a lost JIT acknowledgement', async () => {
    const busy = new Set<string>()
    supplyInventory(busy)
    const retire = idleRetirement()
    loseDelivery = true
    await pool.balance(lease, limits, countedDemand(), undefined, true)
    expect((await allocation()).value.delivery).toBe('requested')
    await pool.balance(lease, limits, [], undefined, true)
    await ageRunners()
    await pool.balance(lease, limits, countedDemand(), undefined, true)
    busy.add((await allocation()).value.name)
    await pool.balance(lease, limits, [], undefined, true)
    expect(retire).not.toHaveBeenCalled()
    expect(backend.workers.stop).not.toHaveBeenCalled()
    expect(backend.workers.deliverJit).toHaveBeenCalledTimes(1)
    expect(await journal.hasCapacity(lease, key, limits)).toBe(false)
  })
  it('keeps new, busy and still-needed runners out of idle retirement', async () => {
    const busy = new Set<string>()
    supplyInventory(busy)
    const retire = idleRetirement()
    await pool.balance(lease, limits, countedDemand(), undefined, true)
    await pool.balance(lease, limits, [], undefined, true)
    await ageRunners()
    await pool.balance(lease, limits, countedDemand(), undefined, true)
    busy.add((await allocation()).value.name)
    await pool.balance(lease, limits, [], undefined, true)
    expect(retire).not.toHaveBeenCalled()
    expect(backend.workers.stop).not.toHaveBeenCalled()
  })
  it('uses all queue counters for retirement even when reservation fences cover only one counter', async () => {
    supplyInventory()
    const retire = idleRetirement()
    await organizationDemand(101)
    const capacity = testCapacity({ account: 3, tenant: 3 })
    await pool.balance(lease, capacity, await durableDemands(), undefined, true)
    await ageRunners()
    const policy = await state.commit(
      lease,
      Array.from({ length: 98 }, (_, index) => ({ key: `policy/${index}`, expected: null, payload: true })),
    )
    await pool.balance(
      lease,
      { ...capacity, checks: policy.map(({ key, version }) => ({ key, version })) },
      await durableDemands(),
      undefined,
      true,
    )
    expect(retire).not.toHaveBeenCalled()
    expect(backend.workers.stop).not.toHaveBeenCalled()
    expect(await journal.used(definition.organization)).toBe(3)
  })
  it.each([
    [false, false],
    [false, true],
    [new Error('lost unregister response'), false],
    [new Error('lost unregister response'), true],
  ] as const)(
    'preserves an unconfirmed idle retirement across restart: %s, lost JIT acknowledgement: %s',
    async (result, lostJitAcknowledgement) => {
      supplyInventory()
      loseDelivery = lostJitAcknowledgement
      const retire = idleRetirement(result)
      await pool.balance(lease, limits, countedDemand(), undefined, true)
      await ageRunners()
      await pool.balance(lease, limits, [], undefined, true)
      expect(retire).toHaveBeenCalledTimes(1)
      expect((await allocation()).value).toMatchObject({ closing: false, effect: { kind: 'runner-retire' } })
      await pool.balance(lease, limits, [], undefined, true)
      expect(retire).toHaveBeenCalledTimes(1)
      runners.clear()
      await pool.close()
      pool = new WorkerPool(journal, key, async () => backend, settings, observe)
      await pool.balance(lease, limits, [], undefined, true)
      expect(backend.workers.stop).not.toHaveBeenCalled()
      expect(await journal.hasCapacity(lease, key, limits)).toBe(false)
      for (const box of boxes.values()) box.status = 'stopped'
      await pool.balance(lease, limits, [], undefined, true)
      await pool.balance(lease, limits, [], undefined, true)
      expect(await journal.hasCapacity(lease, key, limits)).toBe(true)
    },
  )
  it('retries a durable idle retirement after restart without replacing its original intent', async () => {
    supplyInventory()
    const retire = idleRetirement(false)
    await pool.balance(lease, limits, countedDemand(), undefined, true)
    await ageRunners()
    await pool.balance(lease, limits, [], undefined, true)
    const pending = (await allocation()).value.effect
    expect(pending?.kind).toBe('runner-retire')
    await pool.close()
    pool = new WorkerPool(journal, key, async () => backend, settings, observe)
    retire.mockImplementationOnce(async (identity, guard) => {
      await guard({ kind: 'remove', ...identity })
      expect((await byName(identity.name)).value.effect).toEqual(pending)
      runners.delete(identity.name)
      return true
    })
    await pool.balance(lease, limits, [], undefined, true)
    expect(retire).toHaveBeenCalledTimes(2)
    expect(backend.workers.stop).toHaveBeenCalledTimes(1)
    expect((await allocation()).value).toMatchObject({ closing: true, runner: { phase: 'absent' } })
    expect(await journal.hasCapacity(lease, key, limits)).toBe(false)
  })
  it('rejects a resumed idle retirement when its original allocation version changes', async () => {
    supplyInventory()
    const retire = idleRetirement(false)
    await pool.balance(lease, limits, countedDemand(), undefined, true)
    await ageRunners()
    await pool.balance(lease, limits, [], undefined, true)
    await pool.close()
    pool = new WorkerPool(journal, key, async () => backend, settings, observe)
    retire.mockImplementationOnce(async (identity, guard) => {
      const current = await byName(identity.name)
      await journal.advance(lease, current.record.key, current.record.version, {
        effect: { ...current.value.effect!, id: randomUUID() },
      })
      await guard({ kind: 'remove', ...identity })
      runners.delete(identity.name)
      return true
    })
    await pool.balance(lease, limits, [], undefined, true)
    expect(retire).toHaveBeenCalledTimes(2)
    expect(backend.workers.stop).not.toHaveBeenCalled()
    expect((await allocation()).value.closing).toBe(false)
    expect(await journal.hasCapacity(lease, key, limits)).toBe(false)
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ errorType: 'StateConflict' }))
  })
  it.each([false, true])(
    'does not stop a Box when persisting successful idle retirement loses its confirmation, lost JIT acknowledgement: %s',
    async (lostJitAcknowledgement) => {
      supplyInventory()
      loseDelivery = lostJitAcknowledgement
      idleRetirement()
      await pool.balance(lease, limits, countedDemand(), undefined, true)
      await ageRunners()
      const advance = journal.advance.bind(journal)
      const write = jest.spyOn(journal, 'advance').mockImplementation(async (...args) => {
        if (args[3].runner?.phase === 'absent' && args[3].closing) throw new Error('confirmation write lost')
        return advance(...args)
      })
      await pool.balance(lease, limits, [], undefined, true)
      write.mockRestore()
      expect(runners.size).toBe(0)
      expect((await allocation()).value.effect?.kind).toBe('runner-retire')
      await pool.close()
      pool = new WorkerPool(journal, key, async () => backend, settings, observe)
      await pool.balance(lease, limits, [], undefined, true)
      expect(backend.workers.stop).not.toHaveBeenCalled()
      expect(await journal.hasCapacity(lease, key, limits)).toBe(false)
    },
  )
  it('rejects stale cancellation when a queued observation changes the repository revision', async () => {
    supplyInventory()
    const hint = { installationId: 1, accountId: 7, repositoryId: 21, job: { id: 55, runId: 33 } }
    await state.ingress('1/21', async (tx) => {
      await tx.write(await observeDemand(tx, hint, { status: 'completed', labels: ['boxlite'], runner: null }))
    })
    const [snapshot] = await state.read(['queue-revision/1/21'])
    const original = (await journal.reserve(lease, key, demand, limits, { labels: ['boxlite'] }))!
    const advance = journal.advance.bind(journal)
    const pending = jest.spyOn(journal, 'advance').mockImplementation(async (...args) => {
      if (args[3].closing) {
        await state.ingress('1/21', async (tx) => {
          await tx.write(
            await observeDemand(
              tx,
              { ...hint, job: { id: 56, runId: 33 } },
              {
                status: 'queued',
                labels: ['boxlite'],
                runner: null,
              },
            ),
          )
        })
      }
      return advance(...args)
    })
    try {
      await expect(
        pool.balance(lease, limits, [], undefined, true, [{ key: snapshot.key, version: snapshot.version }]),
      ).rejects.toBeInstanceOf(StateConflict)
      expect((await journal.allocation(lease, original.record.key))!.record.version).toBe(original.record.version)
      expect((await journal.allocation(lease, original.record.key))!.value.closing).toBe(false)
      expect(await journal.used(definition.organization)).toBe(1)
      expect(backend.workers.create).not.toHaveBeenCalled()
    } finally {
      pending.mockRestore()
    }
  })
  it.each([false, true])('retains creation backoff across replacement allocations (async=%s)', async (asynchronous) => {
    supplyInventory()
    const clock = jest.spyOn(Date, 'now')
    let now = Date.now()
    clock.mockImplementation(() => now)
    const queue = new WorkQueue(2, (error) => {
      throw error
    })
    const wake = jest.fn()
    if (asynchronous) pool = new WorkerPool(journal, key, async () => backend, settings, observe, { queue, wake })
    jest.mocked(backend.workers.create).mockImplementation(async (launch) => {
      const row = await byName(launch.name)
      throw new ConfirmedWorkerCreationRejected(row.value.effect!.id)
    })
    const plan = async () => {
      await pool.balance(lease, limits, countedDemand(), undefined, true)
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    try {
      for (const [attempt, delay] of [1000, 2000, 60000].entries()) {
        await plan()
        expect(backend.workers.create).toHaveBeenCalledTimes(attempt + 1)
        expect(await journal.used(definition.organization)).toBe(0)
        expect((await rows()).allocations.size).toBe(0)
        if (asynchronous) expect(wake).toHaveBeenCalledTimes(attempt + 1)
        await plan()
        expect(backend.workers.create).toHaveBeenCalledTimes(attempt + 1)
        now += delay - 1
        await plan()
        expect(backend.workers.create).toHaveBeenCalledTimes(attempt + 1)
        now++
      }
    } finally {
      await queue.close()
      clock.mockRestore()
    }
  })
  it('refreshes demand before creating a recovered reservation and cancels it for an empty queue', async () => {
    supplyInventory()
    const reserved = await journal.reserve(lease, key, demand, limits, { labels: settings.labels })
    expect(reserved).not.toBeNull()
    await expect(pool.balance(lease, limits, countedDemand())).rejects.toBeInstanceOf(DemandUncertain)
    expect(backend.workers.create).not.toHaveBeenCalled()
    await pool.balance(lease, limits, [], undefined, true)
    expect(backend.workers.create).not.toHaveBeenCalled()
    expect(await journal.hasCapacity(lease, key, limits)).toBe(true)
  })
  it('does not create an undispatched reservation when runner inventory fails', async () => {
    await journal.reserve(lease, key, demand, limits, { labels: settings.labels })
    Object.assign(backend, {
      inventory: jest.fn(async () => {
        throw new Error('inventory unavailable')
      }),
    })
    await expect(pool.balance(lease, limits, countedDemand())).rejects.toThrow('inventory unavailable')
    expect(backend.workers.create).not.toHaveBeenCalled()
    expect(await journal.hasCapacity(lease, key, limits)).toBe(false)
  })
  it('counts idle supply and does not remint a runner for unchanged demand', async () => {
    supplyInventory()
    await pool.balance(lease, limits, countedDemand(), undefined, true)
    await pool.balance(lease, limits, countedDemand(), undefined, true)
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
    expect(backend.job).not.toHaveBeenCalled()
  })
  it('keeps an offline runner that is still reported busy out of idle supply without stopping its job', async () => {
    const inventory = supplyInventory()
    await pool.balance(lease, limits, countedDemand(), undefined, true)
    const row = await allocation()
    await state.commit(lease, [
      {
        key: row.record.key,
        expected: row.record.version,
        payload: JSON.parse(
          JSON.stringify({
            ...row.value,
            createdAt: Date.now() - 300001,
            runner: { ...row.value.runner, registeredAt: Date.now() - 300001 },
          }),
        ),
      },
    ])
    inventory.mockResolvedValue([
      { id: row.value.runner.id!, name: row.value.name, busy: true, status: 'offline', labels: [] },
    ])
    await pool.balance(lease, limits, [], undefined, true)
    expect((await allocation()).value.closing).toBe(false)
    expect(backend.workers.stop).not.toHaveBeenCalled()
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
  })
  it('demand fence regression: bounds organization snapshots and advances remaining repositories', async () => {
    const busy = new Set<string>()
    supplyInventory(busy)
    await organizationDemand(101)
    await expect(
      pool.balance(lease, testCapacity({ account: 3, tenant: 3 }), await durableDemands(), undefined, true),
    ).resolves.toBeUndefined()
    expect(backend.workers.create).toHaveBeenCalledTimes(3)
    const initial = [...runners.values()]
    initial.forEach((runner) => busy.add(runner.name))
    const counters = await durableDemands()
    for (const [index, counter] of counters.slice(0, 99).entries())
      await state.ingress(`1/${counter.repositoryId}`, async (tx) => {
        await tx.write(
          await observeDemand(
            tx,
            { ...counter, job: counter.job },
            {
              status: index < initial.length ? 'in_progress' : 'completed',
              labels: ['boxlite'],
              runner: initial[index]?.id ?? null,
            },
          ),
        )
      })
    await pool.balance(lease, testCapacity({ account: 5, tenant: 5 }), await durableDemands(), undefined, true)
    expect(backend.workers.create).toHaveBeenCalledTimes(5)
    expect(await journal.used(definition.organization)).toBe(5)
    expect(backend.workers.stop).not.toHaveBeenCalled()
  })
  it('demand fence regression: leaves room for policy and journal checks without counting omitted counters', async () => {
    supplyInventory()
    await organizationDemand(2)
    const policy = await state.commit(
      lease,
      Array.from({ length: 98 }, (_, index) => ({ key: `policy/${index}`, expected: null, payload: true })),
    )
    await expect(
      pool.balance(
        lease,
        testCapacity({ account: 3, tenant: 3, checks: policy.map(({ key, version }) => ({ key, version })) }),
        await durableDemands(),
        undefined,
        true,
      ),
    ).resolves.toBeUndefined()
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
    expect(await journal.used(definition.organization)).toBe(1)
  })
  it('fills configured capacity from a large single counter without a worker batch cap', async () => {
    supplyInventory()
    await pool.balance(lease, testCapacity({ account: 4, tenant: 4 }), countedDemand(5000), undefined, true)
    expect(backend.workers.create).toHaveBeenCalledTimes(4)
    expect(await journal.used(definition.organization)).toBe(4)
  })
  it('does not open a backend for an empty clean scope and zero queued demand', async () => {
    const open = jest.fn(async () => backend)
    pool = new WorkerPool(journal, key, open, settings, observe)
    await pool.balance(lease, limits, [], undefined, true)
    await pool.balance(lease, limits, countedDemand(0), undefined, true)
    expect(open).not.toHaveBeenCalled()
    expect(backend.workers.create).not.toHaveBeenCalled()
    expect(await journal.used(definition.organization)).toBe(0)
  })
  it('withholds creation when the backend cannot enumerate runner supply', async () => {
    await expect(pool.balance(lease, limits, countedDemand(), undefined, true)).rejects.toThrow(
      'supply inventory is unavailable',
    )
    expect(backend.admit).not.toHaveBeenCalled()
    expect(backend.workers.create).not.toHaveBeenCalled()
    expect(await journal.used(definition.organization)).toBe(0)
  })
  it.each(['failed', 'unavailable'])(
    'inventory failure regression: cleans stopped Boxes when inventory is %s',
    async (mode) => {
      const inventory = supplyInventory()
      await pool.balance(lease, limits, countedDemand(), undefined, true)
      const row = await allocation()
      boxes.get(row.value.name)!.status = 'stopped'
      if (mode === 'failed') inventory.mockRejectedValue(new Error('inventory unavailable'))
      else delete backend.inventory
      await expect(pool.balance(lease, limits, countedDemand(2), undefined, true)).rejects.toThrow(/inventory/)
      expect(backend.workers.remove).toHaveBeenCalledWith(row.value.name)
      expect(await journal.used(definition.organization)).toBe(1)
      await expect(pool.balance(lease, limits, countedDemand(2), undefined, true)).rejects.toThrow(/inventory/)
      expect((await rows()).allocations.size).toBe(0)
      expect(await journal.used(definition.organization)).toBe(0)
      expect(backend.workers.create).toHaveBeenCalledTimes(1)
      expect(backend.workers.deliverJit).toHaveBeenCalledTimes(1)
    },
  )
  it.each(['missing', 'offline'])(
    'unavailable supply regression: closes a delivered running worker whose runner is %s',
    async (mode) => {
      const inventory = supplyInventory()
      await pool.balance(lease, limits, countedDemand(), undefined, true)
      const row = await allocation()
      await state.commit(lease, [
        {
          key: row.record.key,
          expected: row.record.version,
          payload: JSON.parse(
            JSON.stringify({
              ...row.value,
              createdAt: Date.now() - 300000,
              runner: { phase: row.value.runner.phase, id: row.value.runner.id },
            }),
          ),
        },
      ])
      inventory.mockImplementation(async () =>
        mode === 'missing'
          ? []
          : [...runners.values()].map((runner) => ({
              ...runner,
              busy: false,
              status: 'offline' as const,
              labels: [...settings.labels],
            })),
      )
      await pool.balance(lease, limits, countedDemand(), undefined, true)
      expect((await journal.allocation(lease, row.record.key))?.value.closing).toBe(true)
      expect(backend.workers.stop).toHaveBeenCalledWith(row.value.name)
      expect(await journal.used(definition.organization)).toBe(1)
      expect(backend.workers.create).toHaveBeenCalledTimes(1)
      await pool.balance(lease, limits, countedDemand(), undefined, true)
      expect(backend.workers.remove).toHaveBeenCalledWith(row.value.name)
      expect(await journal.used(definition.organization)).toBe(1)
      await pool.balance(lease, limits, countedDemand(), undefined, true)
      expect(await journal.allocation(lease, row.record.key)).toBeUndefined()
      expect(await journal.used(definition.organization)).toBe(0)
      expect(backend.workers.create).toHaveBeenCalledTimes(1)
      supplyInventory()
      await pool.balance(lease, limits, countedDemand(), undefined, true)
      expect(backend.workers.create).toHaveBeenCalledTimes(2)
    },
  )
  it.each(['missing', 'offline'])(
    'late registration regression: preserves a fresh %s runner from an aged reservation',
    async (mode) => {
      const inventory = supplyInventory(),
        capacity = testCapacity({ account: 2, tenant: 2 })
      const reserved = (await journal.reserve(lease, key, demand, capacity, { labels: ['boxlite'] }))!,
        createdAt = Date.now() - 300001
      await state.commit(lease, [
        {
          key: reserved.record.key,
          expected: reserved.record.version,
          payload: JSON.parse(JSON.stringify({ ...reserved.value, createdAt })),
        },
      ])
      await pool.balance(lease, capacity, countedDemand(), undefined, true)
      expect((await allocation()).value.delivery).toBe('done')
      inventory.mockImplementation(async () =>
        mode === 'missing'
          ? []
          : [...runners.values()].map((runner) => ({
              ...runner,
              busy: false,
              status: 'offline' as const,
              labels: [],
            })),
      )
      await pool.balance(lease, capacity, countedDemand(), undefined, true)
      const recovered = (await journal.allocation(lease, reserved.record.key))!
      expect(recovered.value.closing).toBe(false)
      expect(backend.workers.stop).not.toHaveBeenCalled()
      expect(backend.workers.create).toHaveBeenCalledTimes(1)
      expect(recovered.value.createdAt).toBe(createdAt)
      expect(recovered.value.runner).toMatchObject({ registeredAt: expect.any(Number) })
      expect(await journal.used(definition.organization)).toBe(1)
    },
  )
  it.each(['missing', 'offline'])(
    'runner startup regression: preserves %s supply until the bootstrap grace expires',
    async (mode) => {
      const inventory = supplyInventory(),
        capacity = testCapacity({ account: 2, tenant: 2 })
      await pool.balance(lease, capacity, countedDemand(), undefined, true)
      const row = await allocation(),
        now = Date.now()
      await state.commit(lease, [
        {
          key: row.record.key,
          expected: row.record.version,
          payload: JSON.parse(
            JSON.stringify({ ...row.value, runner: { ...row.value.runner, registeredAt: now - 299999 } }),
          ),
        },
      ])
      inventory.mockImplementation(async () =>
        mode === 'missing'
          ? []
          : [...runners.values()].map((runner) => ({
              ...runner,
              busy: false,
              status: 'offline' as const,
              labels: [],
            })),
      )
      const clock = jest.spyOn(Date, 'now').mockReturnValue(now)
      try {
        await pool.balance(lease, capacity, countedDemand(), undefined, true)
        expect((await journal.allocation(lease, row.record.key))?.value).toMatchObject({
          closing: false,
          delivery: 'done',
        })
        expect(backend.workers.stop).not.toHaveBeenCalled()
        expect(backend.workers.create).toHaveBeenCalledTimes(1)
        expect(await journal.used(definition.organization)).toBe(1)
        clock.mockReturnValue(now + 1)
        await pool.balance(lease, capacity, countedDemand(), undefined, true)
        expect((await journal.allocation(lease, row.record.key))?.value.closing).toBe(true)
        expect(backend.workers.stop).toHaveBeenCalledWith(row.value.name)
        expect(await journal.used(definition.organization)).toBe(2)
      } finally {
        clock.mockRestore()
      }
    },
  )
  it('recovers legacy allocation labels while balancing an initially empty runner inventory', async () => {
    supplyInventory()
    const reserved = (await journal.reserve(lease, key, demand, limits))!
    const label = 'boxlite-4vcpu-8gbmem-20gbdisk'
    customJob([label])
    await pool.balance(lease, limits, countedDemand(1, [label]), undefined, true)
    expect(backend.job).toHaveBeenCalledWith(demand, undefined)
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
    expect(backend.workers.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: reserved.value.name, cpus: 4, memoryMiB: 8192, diskGiB: 20 }),
    )
    expect(backend.runners).toHaveBeenLastCalledWith(
      expect.any(Function),
      undefined,
      ['self-hosted', 'linux', 'x64', label],
      reserved.value.name,
    )
    expect((await allocation()).value.delivery).toBe('done')
    expect(await journal.used(definition.organization)).toBe(1)
  })
  it.each(['legacy', 'snapshot'])(
    'rejects unsupported %s supply before creating or retiring resources',
    async (kind) => {
      supplyInventory()
      const retire = jest.fn(async () => {})
      backend.retire = retire
      customJob(['boxlite', 'macOS'])
      await journal.reserve(
        lease,
        key,
        demand,
        limits,
        kind === 'snapshot' ? { labels: ['boxlite', 'macOS'] } : undefined,
      )
      await expect(pool.balance(lease, limits, countedDemand(), undefined, true)).rejects.toBeInstanceOf(StateCorrupt)
      expect(backend.workers.create).not.toHaveBeenCalled()
      expect(retire).not.toHaveBeenCalled()
      expect(await journal.used(definition.organization)).toBe(1)
    },
  )
  it('replaces busy supply with a persisted running claim without requiring fallback', async () => {
    const busy = new Set<string>()
    supplyInventory(busy)
    const capacity = testCapacity({ account: 2, tenant: 2 })
    await pool.balance(lease, capacity, countedDemand(), undefined, true)
    const row = await allocation()
    busy.add(row.value.name)
    await state.ingress('1/21', async (tx) => {
      await tx.write(
        await observeDemand(
          tx,
          { installationId: 1, accountId: 7, repositoryId: 21, job: { id: demand.job, runId: demand.run } },
          { status: 'in_progress', labels: ['boxlite'], runner: row.value.runner.id },
        ),
      )
    })
    await pool.balance(lease, capacity, countedDemand(), undefined, true)
    expect(backend.workers.create).toHaveBeenCalledTimes(2)
    expect(backend.workers.stop).not.toHaveBeenCalled()
    expect((await rows()).allocations.size).toBe(2)
  })
  it('requires queue fallback before replacing busy supply without a running observation', async () => {
    const busy = new Set<string>()
    supplyInventory(busy)
    const capacity = testCapacity({ account: 2, tenant: 2 })
    await pool.balance(lease, capacity, countedDemand(), undefined, true)
    busy.add((await allocation()).value.name)
    await expect(pool.balance(lease, capacity, countedDemand())).rejects.toThrow('without matching demand observations')
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
    await pool.balance(lease, capacity, countedDemand(), undefined, true)
    expect(backend.workers.create).toHaveBeenCalledTimes(2)
  })
  it('does not let cleanup occupy supply for pending label demand', async () => {
    supplyInventory()
    const capacity = testCapacity({ account: 2, tenant: 2 })
    await pool.balance(lease, capacity, countedDemand(), undefined, true)
    const row = await allocation()
    await journal.advance(lease, row.record.key, row.record.version, { closing: true })
    await pool.balance(lease, capacity, countedDemand(), undefined, true)
    expect(backend.workers.create).toHaveBeenCalledTimes(2)
    expect(backend.workers.stop).toHaveBeenCalledTimes(1)
  })
  it('rejects a renamed known runner before using it as supply', async () => {
    const inventory = supplyInventory()
    await pool.balance(lease, limits, countedDemand(), undefined, true)
    inventory.mockImplementation(async () =>
      [...runners.values()].map((runner) => ({
        ...runner,
        name: 'another-runner',
        busy: false,
        status: 'online',
        labels: [...settings.labels],
      })),
    )
    await expect(pool.balance(lease, limits, countedDemand(), undefined, true)).rejects.toBeInstanceOf(StateCorrupt)
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
  })
  it('rejects incompatible advertised supply labels rather than borrowing another profile', async () => {
    const inventory = supplyInventory()
    await pool.balance(lease, limits, countedDemand(), undefined, true)
    inventory.mockImplementation(async () =>
      [...runners.values()].map((runner) => ({
        ...runner,
        busy: false,
        status: 'online',
        labels: ['boxlite-4vcpu-8gbmem-20gbdisk'],
      })),
    )
    await expect(pool.balance(lease, limits, countedDemand(), undefined, true)).rejects.toBeInstanceOf(StateCorrupt)
  })
  it('withholds creation for dirty counts and unsupported requested labels', async () => {
    supplyInventory()
    await expect(
      pool.balance(lease, limits, [{ ...countedDemand()[0], dirty: true }], undefined, true),
    ).rejects.toBeInstanceOf(StateCorrupt)
    await pool.balance(lease, limits, countedDemand(1, ['boxlite', 'unsupported']), undefined, true)
    expect(backend.workers.create).not.toHaveBeenCalled()
  })
  it('keeps uncertain creation reserved while another allocation makes progress', async () => {
    supplyInventory()
    const original = jest.mocked(backend.workers.create).getMockImplementation()!
    jest
      .mocked(backend.workers.create)
      .mockImplementationOnce(async () => {
        throw new Error('unknown create outcome')
      })
      .mockImplementation(original)
    const capacity = testCapacity({ account: 2, tenant: 2 })
    await pool.balance(lease, capacity, countedDemand(2), undefined, true)
    const allocations = [...(await rows()).allocations.values()]
    expect(allocations.some((row) => row.value.box.phase === 'requested')).toBe(true)
    expect(allocations.some((row) => row.value.delivery === 'done')).toBe(true)
    await pool.balance(lease, capacity, countedDemand(2), undefined, true)
    expect(backend.workers.create).toHaveBeenCalledTimes(2)
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ event: 'ci-worker-recovery-deferred' })]))
  })
  it.each([new LeaseLost(), new StateCorrupt()])('propagates fatal counted creation failure %s', async (failure) => {
    supplyInventory()
    jest.mocked(backend.workers.create).mockRejectedValueOnce(failure)
    await expect(pool.balance(lease, limits, countedDemand(), undefined, true)).rejects.toBe(failure)
    expect((await allocation()).value.box.phase).toBe('requested')
    expect(await journal.used(definition.organization)).toBe(1)
    expect(backend.workers.deliverJit).not.toHaveBeenCalled()
  })
  it('retains uncertain creation and retires credentials after a non-Error provider rejection', async () => {
    supplyInventory()
    const retire = jest.fn(async () => {})
    backend.retire = retire
    jest.mocked(backend.workers.create).mockRejectedValueOnce('private-provider-response')
    await pool.balance(lease, limits, countedDemand(), undefined, true)
    const row = await allocation()
    expect(row.value.box.phase).toBe('requested')
    expect(await journal.used(definition.organization)).toBe(1)
    expect(retire.mock.calls).toEqual([[row.value.name], [row.value.name]])
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'ci-worker-recovery-deferred', errorType: 'Unknown' }),
    )
    expect(JSON.stringify(events)).not.toContain('private-provider-response')
    expect(backend.workers.deliverJit).not.toHaveBeenCalled()
  })
  it('rejects a recovered supply snapshot incompatible with current pool labels', async () => {
    const reserved = (await journal.reserve(lease, key, demand, limits, { labels: ['boxlite', 'macOS'] }))!
    await expect(reconcile()).rejects.toBeInstanceOf(StateCorrupt)
    expect((await journal.allocation(lease, reserved.record.key))?.value.box.phase).toBe('none')
    expect(await journal.used(definition.organization)).toBe(1)
    expect(backend.job).not.toHaveBeenCalled()
    expect(backend.workers.create).not.toHaveBeenCalled()
  })
  it('uses the original job resource selection for both launch and registration', async () => {
    customJob()
    await tick()
    expect(backend.workers.create).toHaveBeenCalledWith(
      expect.objectContaining({ cpus: 2, memoryMiB: 4096, diskGiB: 10 }),
    )
    expect(backend.runners).toHaveBeenLastCalledWith(
      expect.any(Function),
      undefined,
      ['self-hosted', 'linux', 'x64', 'boxlite-2vcpu-4gbmem-10gbdisk'],
      (await allocation()).value.name,
    )
    expect((await allocation()).value.delivery).toBe('done')
  })
  it.each([
    ['boxlite-0vcpu-4gbmem-10gbdisk'],
    ['boxlite-17vcpu-4gbmem-10gbdisk'],
    ['boxlite-2vcpu-Infinitygbmem-10gbdisk'],
    ['boxlite', 'boxlite-2vcpu-4gbmem-10gbdisk'],
    ['boxlite-2vcpu-4gbmem-10gbdisk', 'macOS'],
  ])('rejects unsupported resources before reservation: %j', (...labels) => {
    return (async () => {
      customJob(labels)
      await tick()
      expect((await rows()).allocations.size).toBe(0)
      expect(backend.workers.create).not.toHaveBeenCalled()
      expect(backend.runners).not.toHaveBeenCalled()
    })()
  })
  it('rereads resources from a reserved job after restart without persisting resource fields', async () => {
    const reserved = await journal.reserve(lease, key, demand, limits)
    expect(Object.keys(reserved!.value)).not.toContain('resources')
    customJob(['boxlite-4vcpu-8gbmem-20gbdisk'])
    pool = new WorkerPool(journal, key, async () => backend, settings, observe)
    await reconcile()
    expect(backend.job).toHaveBeenCalledWith(demand, undefined)
    expect(backend.workers.create).toHaveBeenCalledWith(
      expect.objectContaining({ cpus: 4, memoryMiB: 8192, diskGiB: 20 }),
    )
    expect(backend.runners).toHaveBeenLastCalledWith(
      expect.any(Function),
      undefined,
      ['self-hosted', 'linux', 'x64', 'boxlite-4vcpu-8gbmem-20gbdisk'],
      (await allocation()).value.name,
    )
  })
  it('recovers an uncertain original create before a failing job reread without repeating create', async () => {
    customJob()
    loseBox = true
    await expect(tick()).rejects.toThrow('lost Box response')
    const original = boxes.values().next().value!.box_id
    jest.mocked(backend.job).mockRejectedValue(new Error('GitHub temporarily unavailable'))
    pool = new WorkerPool(journal, key, async () => backend, settings, observe)
    await expect(reconcile()).rejects.toThrow('GitHub temporarily unavailable')
    expect((await allocation()).value.box).toEqual({ phase: 'known', id: original })
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
    customJob()
    await reconcile()
    expect((await allocation()).value.delivery).toBe('done')
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
  })
  it('reparses a new job after the previous worker releases capacity', async () => {
    customJob()
    await tick()
    await finishBox()
    customJob(['boxlite-1vcpu-1gbmem-1gbdisk'])
    await tick({ ...demand, job: 56 })
    expect(backend.workers.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ cpus: 1, memoryMiB: 1024, diskGiB: 1 }),
    )
  })
  it('journals effects, delivers once, then returns quota only after both original resources are absent', async () => {
    await tick()
    const active = await allocation(),
      scope = (await rows()).scopes.get(key)!
    expect(active.value.delivery).toBe('done')
    expect(scope.active).toEqual([active.record.key])
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
    expect(backend.workers.deliverJit).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(await state.recover(lease))).not.toContain('c2VjcmV0')
    await finishBox()
    expect((await rows()).allocations.size).toBe(0)
    expect(boxes.size).toBe(0)
    expect(runners.size).toBe(0)
    expect((await rows()).scopes.get(key)!.active).toEqual([])
  })
  it('does not create another worker for a duplicate notice while the allocation is active', async () => {
    await tick()
    await tick()
    expect((await rows()).allocations.size).toBe(1)
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
  })
  it('creation refusal regression: returns capacity immediately and retries queued demand after the delay', async () => {
    const now = Date.now(),
      clock = jest.spyOn(Date, 'now').mockReturnValue(now)
    jest.mocked(backend.workers.create).mockImplementationOnce(async (launch) => {
      const row = await byName(launch.name)
      throw new ConfirmedWorkerCreationRejected(row.value.effect!.id)
    })
    try {
      await expect(tick()).resolves.toBeUndefined()
      expect((await rows()).allocations.size).toBe(0)
      expect((await rows()).workers).toHaveLength(0)
      expect(backend.runners).not.toHaveBeenCalled()
      expect(backend.workers.get).not.toHaveBeenCalled()
      await tick()
      expect(backend.workers.create).toHaveBeenCalledTimes(1)
      clock.mockReturnValue(now + 1000)
      await tick()
      expect((await rows()).allocations.size).toBe(1)
      expect(backend.workers.create).toHaveBeenCalledTimes(2)
      expect(backend.workers.deliverJit).toHaveBeenCalledTimes(1)
    } finally {
      clock.mockRestore()
    }
  })
  it('allows another resource profile while default creation is backing off', async () => {
    supplyInventory()
    const capacity = testCapacity({ account: 2, tenant: 2 })
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now())
    jest.mocked(backend.workers.create).mockImplementationOnce(async (launch) => {
      const row = await byName(launch.name)
      throw new ConfirmedWorkerCreationRejected(row.value.effect!.id)
    })
    try {
      await pool.balance(lease, capacity, countedDemand(), undefined, true)
      await pool.balance(lease, capacity, countedDemand(1, ['boxlite-4vcpu-8gbmem-20gbdisk']), undefined, true)
      expect(backend.workers.create).toHaveBeenCalledTimes(2)
      expect(backend.workers.create).toHaveBeenLastCalledWith(expect.objectContaining({ cpus: 4 }))
      jest.mocked(backend.inventory!).mockResolvedValue(
        [...runners.values()].map((runner) => ({
          ...runner,
          busy: false,
          status: 'online',
          labels: ['self-hosted', 'linux', 'x64', 'boxlite-4vcpu-8gbmem-20gbdisk'],
        })),
      )
      await pool.balance(lease, capacity, countedDemand(), undefined, true)
      expect(backend.workers.create).toHaveBeenCalledTimes(2)
      expect(await journal.used(definition.organization)).toBe(1)
    } finally {
      clock.mockRestore()
    }
  })
  it('clears creation refusal history after a successful persisted create', async () => {
    let now = Date.now()
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now)
    const refuse = async (launch: Parameters<typeof backend.workers.create>[0]) => {
      throw new ConfirmedWorkerCreationRejected((await byName(launch.name)).value.effect!.id)
    }
    try {
      jest.mocked(backend.workers.create).mockImplementationOnce(refuse)
      await tick()
      now += 1000
      await tick()
      await finishBox()
      jest.mocked(backend.workers.create).mockImplementationOnce(refuse)
      await tick({ ...demand, job: 56 })
      now += 1000
      await tick({ ...demand, job: 56 })
      expect(backend.workers.create).toHaveBeenCalledTimes(4)
      expect((await allocation()).value.delivery).toBe('done')
    } finally {
      clock.mockRestore()
    }
  })
  it('creation refusal regression: restart consumes a persisted refusal without retrying the original create', async () => {
    loseBox = true
    materializeBox = false
    await expect(tick()).rejects.toThrow('lost Box response')
    const row = await allocation()
    jest.mocked(backend.workers.get).mockRejectedValue(new ConfirmedWorkerCreationRejected(row.value.effect!.id))
    await pool.close()
    pool = new WorkerPool(journal, key, async () => backend, settings, observe)
    await expect(reconcile()).resolves.toBeUndefined()
    expect((await rows()).allocations.size).toBe(0)
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
    expect(backend.runners).not.toHaveBeenCalled()
  })
  it('creation refusal boundary: a generic HTTP error or mismatched operation retains capacity', async () => {
    jest.mocked(backend.workers.create).mockImplementationOnce(async (launch) => {
      const row = await byName(launch.name)
      throw Object.assign(Error('upstream 429'), { status: 429, rejectedCreationEffect: row.value.effect!.id })
    })
    await expect(tick()).rejects.toThrow('upstream 429')
    expect((await rows()).workers).toHaveLength(1)
    jest.mocked(backend.workers.get).mockRejectedValue(new ConfirmedWorkerCreationRejected(randomUUID()))
    await expect(reconcile()).rejects.toThrow()
    expect((await rows()).workers).toHaveLength(1)
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
  })
  it('creation refusal boundary: a marker cannot retire a known Box or registration', async () => {
    await tick()
    const row = await allocation()
    jest.mocked(backend.workers.get).mockRejectedValue(new ConfirmedWorkerCreationRejected(row.value.effect!.id))
    await expect(reconcile()).rejects.toThrow()
    const current = await allocation()
    expect(current.value.box).toEqual(row.value.box)
    expect((await rows()).workers).toHaveLength(1)
    expect(backend.workers.remove).not.toHaveBeenCalled()
  })
  it('recovery regression: a deleted Box with a busy GitHub runner does not block a new job', async () => {
    await tick()
    const first = await allocation()
    boxes.delete(first.value.name)
    busyRunner = true
    await expect(pool.tick(lease, limits, { ...demand, job: 56 })).resolves.toBeUndefined()
    const snapshot = await rows()
    expect(snapshot.allocations.get(first.record.key)?.value.box.phase).toBe('absent')
    expect(snapshot.allocations.get(first.record.key)?.value.runner.phase).toBe('known')
    expect(snapshot.allocations.size).toBe(2)
    expect(snapshot.workers.filter((worker) => worker.installation.account.id === 7).length).toBe(1)
    expect(backend.workers.create).toHaveBeenCalledTimes(2)
    expect(backend.workers.deliverJit).toHaveBeenCalledTimes(2)
  })
  it('recovery regression: one cleanup failure does not skip another stopped Box', async () => {
    const two = testCapacity({ account: 2, tenant: 2 })
    await pool.tick(lease, two, demand)
    await pool.tick(lease, two, { ...demand, job: 56 })
    const allocations = [...(await rows()).allocations.values()]
    const first = allocations.find((row) => row.value.job.job === demand.job)!
    const second = allocations.find((row) => row.value.job.job === 56)!
    boxes.delete(first.value.name)
    boxes.get(second.value.name)!.status = 'stopped'
    busyRunner = true
    await expect(pool.tick(lease, two)).resolves.toBeUndefined()
    expect(backend.workers.remove).toHaveBeenCalledWith(second.value.name)
    expect(boxes.has(second.value.name)).toBe(false)
    expect((await rows()).allocations.get(first.record.key)?.value.runner.phase).toBe('known')
  })
  it('recovers a positive original Box ledger result without replaying create', async () => {
    loseBox = true
    await expect(tick()).rejects.toThrow('lost Box response')
    expect((await allocation()).value.box.phase).toBe('requested')
    await reconcile()
    expect((await allocation()).value.delivery).toBe('done')
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
  })
  it('retains unknown Box creation and quota when no original ID can be recovered', async () => {
    loseBox = true
    materializeBox = false
    await expect(tick()).rejects.toThrow('lost Box response')
    await expect(reconcile()).rejects.toThrow('unknown Box create outcome')
    expect((await allocation()).value.box).toEqual({ phase: 'requested', id: null })
    expect(await journal.reserve(lease, key, { ...demand, job: 56 }, limits)).toBeUndefined()
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
  })
  it('recovers a positively identified unknown registration only for cleanup', async () => {
    loseRunner = true
    await expect(tick()).rejects.toThrow('lost JIT response')
    await reconcile()
    await reconcile()
    await reconcile()
    expect((await rows()).allocations.size).toBe(0)
    expect(runners.size).toBe(0)
    expect(backend.workers.deliverJit).not.toHaveBeenCalled()
    expect(nextRunner).toBe(91)
  })
  it('retains unknown runner registration debt and job dedup after returning confirmed-absent Box quota', async () => {
    loseRunner = true
    materializeRunner = false
    await expect(tick()).rejects.toThrow('lost JIT response')
    await reconcile()
    await reconcile()
    await reconcile()
    const pending = await allocation()
    expect(pending.value.box.phase).toBe('absent')
    expect(pending.value.runner.phase).toBe('requested')
    expect(await journal.reserve(lease, key, demand, limits)).toBeUndefined()
    expect(await journal.reserve(lease, key, { ...demand, job: 56 }, limits)).toBeDefined()
    expect(nextRunner).toBe(91)
  })
  it.each([0, 137, null])(
    'reports observed exit %s with original IDs without declaring a CI verdict',
    async (exit_code) => {
      await tick()
      const first = await allocation()
      Object.assign(boxes.get(first.value.name)!, { status: 'stopped', exit_code })
      await reconcile()
      expect(events).toContainEqual(
        expect.objectContaining({
          event: 'ci-worker-exited',
          level: exit_code === 0 ? 'info' : 'warn',
          status: 'stopped',
          exitCode: exit_code,
          boxId: first.value.box.id,
          runnerId: first.value.runner.id,
          trigger: demand,
          binding: definition.binding,
          organization: definition.organization,
          installation: 1,
          account: 7,
          boxPhase: 'known',
          runnerPhase: 'known',
        }),
      )
      await reconcile()
      expect(events).toContainEqual(
        expect.objectContaining({
          event: 'ci-worker-released',
          level: 'info',
          boxPhase: 'absent',
          runnerPhase: 'absent',
        }),
      )
      expect(JSON.stringify(events)).not.toMatch(/c2VjcmV0|failed|cancelled|token/)
    },
  )
  it('reports an unexpected deletion and persistent runner cleanup debt with no secret error message', async () => {
    await tick()
    const first = await allocation()
    boxes.delete(first.value.name)
    busyRunner = true
    await reconcile()
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'ci-worker-box-absent', level: 'warn', boxId: first.value.box.id }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'ci-worker-recovery-deferred',
        errorType: 'Error',
        effect: 'runner-remove',
        boxPhase: 'absent',
        runnerPhase: 'known',
        trigger: demand,
      }),
    )
    expect(JSON.stringify(events)).not.toContain('GitHub runner is busy')
    pool = new WorkerPool(journal, key, async () => backend, settings, observe)
    busyRunner = false
    await reconcile()
    expect((await rows()).allocations.size).toBe(0)
    expect(events).toContainEqual(expect.objectContaining({ event: 'ci-worker-released', boxId: first.value.box.id }))
  })
  it('rejects a recovery round that omits a counted active worker', async () => {
    const capacity = testCapacity({ account: 2, tenant: 2 })
    const original = (await journal.reserve(lease, key, demand, capacity))!
    const [membership] = await state.read(['active-worker/' + key.slice(6) + '/' + original.record.key.slice(7)])
    await state.commit(lease, [{ key: membership.key, expected: membership.version }])
    await expect(pool.tick(lease, capacity, { ...demand, job: 999 })).rejects.toBeInstanceOf(StateCorrupt)
    expect(backend.workers.create).not.toHaveBeenCalled()
  })
  it('restarts paged recovery after a lease change instead of carrying readiness forward', async () => {
    const capacity = testCapacity({ account: 100, tenant: 100 })
    for (let job = 100; job < 133; job++) await journal.reserve(lease, key, { ...demand, job }, capacity)
    await pool.tick(lease, capacity)
    await pool.tick(lease, capacity)
    await db.transaction(lease.namespace, async (tx) => {
      const expiry = (await tx.get('@lease'))!
      await tx.put(
        { ...expiry, version: randomUUID(), payload: { ...(expiry.payload as object), until: 0 } },
        expiry.version,
      )
    })
    lease = (await state.acquire(randomUUID(), 300000))!
    await pool.tick(lease, capacity, { ...demand, job: 999 })
    expect([...(await rows()).allocations.values()].some((row) => row.value.job.job === 999)).toBe(false)
    await pool.tick(lease, capacity, { ...demand, job: 999 })
    expect([...(await rows()).allocations.values()].some((row) => row.value.job.job === 999)).toBe(true)
  })
  it('withholds admission when recovery membership changes between pages', async () => {
    const capacity = testCapacity({ account: 100, tenant: 100 })
    for (let job = 100; job < 133; job++) await journal.reserve(lease, key, { ...demand, job }, capacity)
    await pool.tick(lease, capacity, { ...demand, job: 999 })
    expect([...(await rows()).allocations.values()].some((row) => row.value.job.job === 999)).toBe(false)
    await journal.reserve(lease, key, { ...demand, job: 700 }, capacity)
    await pool.tick(lease, capacity, { ...demand, job: 999 })
    expect([...(await rows()).allocations.values()].some((row) => row.value.job.job === 999)).toBe(false)
    await pool.tick(lease, capacity, { ...demand, job: 999 })
    await pool.tick(lease, capacity, { ...demand, job: 999 })
    expect([...(await rows()).allocations.values()].filter((row) => row.value.job.job === 999)).toHaveLength(1)
  })
  it('keeps later-page failures blocked across cursor wraps until an entirely clean round', async () => {
    const capacity = testCapacity({ account: 100, tenant: 100 })
    for (let job = 100; job < 133; job++) await journal.reserve(lease, key, { ...demand, job }, capacity)
    const tail = [...(await rows()).allocations.values()].at(-1)!
    const get = jest.mocked(backend.workers.get).getMockImplementation()!
    jest.mocked(backend.workers.get).mockImplementation(async (name) => {
      if (name === tail.value.name) throw new Error('tail lookup failed')
      return get(name)
    })
    const hasDemand = async () => [...(await rows()).allocations.values()].some((row) => row.value.job.job === 999)
    for (let round = 0; round < 2; round++) {
      await pool.tick(lease, capacity, { ...demand, job: 999 })
      expect(await hasDemand()).toBe(false)
      await expect(pool.tick(lease, capacity, { ...demand, job: 999 })).rejects.toThrow('tail lookup failed')
      expect(await hasDemand()).toBe(false)
    }
    jest.mocked(backend.workers.get).mockImplementation(get)
    await pool.tick(lease, capacity, { ...demand, job: 999 })
    expect(await hasDemand()).toBe(false)
    await pool.tick(lease, capacity, { ...demand, job: 999 })
    expect(await hasDemand()).toBe(true)
  })
  it('keeps quota and blocks admission on lookup failure but still reconciles other workers', async () => {
    const two = testCapacity({ account: 2, tenant: 2 })
    await pool.tick(lease, two, demand)
    await pool.tick(lease, two, { ...demand, job: 56 })
    const allocations = [...(await rows()).allocations.values()]
    const first = allocations.find((row) => row.value.job.job === demand.job)!
    const second = allocations.find((row) => row.value.job.job === 56)!
    boxes.get(second.value.name)!.status = 'stopped'
    const get = jest.mocked(backend.workers.get).getMockImplementation()!
    jest.mocked(backend.workers.get).mockImplementation(async (name) => {
      if (name === first.value.name) throw new Error('private-test-network-secret')
      return get(name)
    })
    const admissions = jest.mocked(backend.admit).mock.calls.length
    await expect(pool.tick(lease, two, { ...demand, job: 57 })).rejects.toThrow('private-test-network-secret')
    expect(backend.workers.remove).toHaveBeenCalledWith(second.value.name)
    expect((await rows()).workers.filter((worker) => worker.installation.account.id === 7).length).toBe(2)
    expect((await rows()).allocations.get(first.record.key)?.value.box.phase).toBe('known')
    expect(backend.admit).toHaveBeenCalledTimes(admissions)
    expect(JSON.stringify(events)).not.toContain('private-test-network-secret')
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'ci-worker-recovery-deferred',
        boxId: first.value.box.id,
        trigger: demand,
        errorType: 'Error',
      }),
    )
  })
  it.each([new LeaseLost(), new StateCorrupt()])('stops immediately on fatal recovery %s', async (failure) => {
    const two = testCapacity({ account: 2, tenant: 2 })
    await pool.tick(lease, two, demand)
    await pool.tick(lease, two, { ...demand, job: 56 })
    jest.mocked(backend.workers.get).mockRejectedValueOnce(failure)
    const reads = jest.mocked(backend.workers.get).mock.calls.length
    await expect(pool.tick(lease, two, { ...demand, job: 57 })).rejects.toBe(failure)
    expect(backend.workers.get).toHaveBeenCalledTimes(reads + 1)
    expect(backend.workers.remove).not.toHaveBeenCalled()
    expect(backend.workers.create).toHaveBeenCalledTimes(2)
  })
  it('does not replay uncertain JIT delivery or stop a possibly running CI', async () => {
    loseDelivery = true
    await expect(tick()).rejects.toThrow('lost upload acknowledgement')
    await reconcile()
    expect((await allocation()).value.delivery).toBe('requested')
    expect(backend.workers.deliverJit).toHaveBeenCalledTimes(1)
    expect(backend.workers.stop).not.toHaveBeenCalled()
    await finishBox()
    expect((await rows()).allocations.size).toBe(0)
  })
  it.each(['replace', 'delivered', 'already online'] as const)(
    'reconciles an interrupted Hosted JIT delivery: %s',
    async (outcome) => {
      loseDelivery = true
      await expect(tick()).rejects.toThrow('lost upload acknowledgement')
      const { value } = await allocation()
      Object.assign(boxes.get(value.name)!, { recoverableJit: true })
      const recoverJit = jest.fn(async () => (outcome === 'replace' ? 'replace' : 'delivered'))
      Object.assign(backend.workers, { recoverJit })
      backend.inventory = async () => [
        {
          id: value.runner.id!,
          name: value.name,
          labels: settings.labels,
          status: outcome === 'already online' ? 'online' : 'offline',
          busy: outcome === 'already online',
        },
      ]
      await reconcile()
      if (outcome === 'replace') {
        expect((await allocation()).value.closing).toBe(true)
        expect(backend.workers.stop).toHaveBeenCalledWith(value.name)
      } else {
        expect((await allocation()).value.delivery).toBe('done')
        expect(backend.workers.stop).not.toHaveBeenCalled()
      }
      if (outcome === 'already online') expect(recoverJit).not.toHaveBeenCalled()
      else expect(recoverJit).toHaveBeenCalledWith(value.name, value.effect!.id, undefined)
      expect(backend.workers.deliverJit).toHaveBeenCalledTimes(1)
    },
  )
  it('does not stop an active Box when the triggering job has completed elsewhere', async () => {
    await tick()
    jest.mocked(backend.job).mockImplementation(async (notice) => ({
      ...notice,
      status: 'completed',
      labels: ['boxlite'],
      runner: 42,
    }))
    await tick()
    expect(backend.workers.stop).not.toHaveBeenCalled()
    expect(boxes.size).toBe(1)
  })
  it('rejects revoked admission before create and cleans the unsent reservation', async () => {
    jest.mocked(backend.admit).mockResolvedValueOnce(undefined).mockRejectedValue(new Error('owner revoked'))
    await expect(tick()).rejects.toThrow('owner revoked')
    expect((await allocation()).value.closing).toBe(true)
    await reconcile()
    expect(backend.workers.create).not.toHaveBeenCalled()
    expect((await rows()).allocations.size).toBe(0)
  })
  it('rejects stale execution identity before any backend effects', async () => {
    await expect(pool.tick({ ...lease, owner: 'not-owner' }, limits, demand)).rejects.toBeInstanceOf(LeaseLost)
    expect(backend.workers.create).not.toHaveBeenCalled()
    expect(backend.admit).not.toHaveBeenCalled()
  })
  it('rejects unsupported labels before reserving or creating capacity', async () => {
    jest.mocked(backend.job).mockImplementation(async (notice) => ({
      ...notice,
      status: 'queued',
      labels: ['boxlite', 'macOS'],
      runner: null,
    }))
    await tick()
    expect((await rows()).allocations.size).toBe(0)
    expect(backend.workers.create).not.toHaveBeenCalled()
  })
  it('rejects a job routed to the wrong repository pool', async () => {
    await expect(pool.tick(lease, limits, { ...demand, repository: 22 })).rejects.toThrow('outside its execution scope')
    expect((await rows()).allocations.size).toBe(0)
    expect(backend.workers.create).not.toHaveBeenCalled()
  })
  it('rechecks admission after registration and before publishing JIT', async () => {
    const open = jest.mocked(backend.runners).getMockImplementation()!
    jest.mocked(backend.runners).mockImplementation(async (...args) => {
      const session = await open(...args),
        create = session.registry.create.bind(session.registry)
      session.registry.create = async (...input) => {
        const registration = await create(...input)
        jest.mocked(backend.admit).mockRejectedValue(new Error('owner revoked after registration'))
        return registration
      }
      return session
    })
    await expect(tick()).rejects.toThrow('owner revoked after registration')
    expect((await allocation()).value.closing).toBe(true)
    expect(backend.workers.deliverJit).not.toHaveBeenCalled()
    await reconcile()
    await reconcile()
    await reconcile()
    expect((await rows()).allocations.size).toBe(0)
    expect(runners.size).toBe(0)
  })
  it('cleans original resources after admission was revoked without starting new work', async () => {
    await tick()
    jest.mocked(backend.admit).mockRejectedValue(new Error('owner revoked'))
    const calls = jest.mocked(backend.admit).mock.calls.length
    await finishBox()
    expect((await rows()).allocations.size).toBe(0)
    expect(jest.mocked(backend.admit).mock.calls).toHaveLength(calls)
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
  })
  it('refuses to act on a replacement Box ID', async () => {
    await tick()
    const original = (await allocation()).value.box.id
    jest.mocked(backend.workers.get).mockResolvedValue({ box_id: 'foreign-box', status: 'running' })
    await expect(reconcile()).rejects.toThrow('identity changed')
    expect((await allocation()).value.box.id).toBe(original)
    expect(backend.workers.stop).not.toHaveBeenCalled()
  })
  it('fails recovery when an allocation referenced by a permanent scope disappears', async () => {
    await tick()
    const current = await allocation()
    await state.commit(lease, [{ key: current.record.key, expected: current.record.version }])
    await expect(reconcile()).rejects.toBeInstanceOf(StateCorrupt)
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
    expect(backend.workers.stop).not.toHaveBeenCalled()
  })
  it('keeps an aged running Box even when GitHub would allow runner removal', async () => {
    await tick()
    const current = await allocation()
    await state.commit(lease, [
      {
        key: current.record.key,
        expected: current.record.version,
        payload: JSON.parse(JSON.stringify({ ...current.value, createdAt: Date.now() - 601000 })),
      },
    ])
    await reconcile()
    expect((await allocation()).value.closing).toBe(false)
    expect((await allocation()).value.runner.phase).toBe('known')
    expect(backend.workers.stop).not.toHaveBeenCalled()
    expect(backend.workers.remove).not.toHaveBeenCalled()
    expect(runners.has(current.value.name)).toBe(true)
    expect(boxes.get(current.value.name)?.status).toBe('running')
  })
  it('does not acquire fresh runner credentials while retirement remains unconfirmed', async () => {
    closeFailures = 2
    await expect(tick()).rejects.toThrow('retirement pending')
    const opened = jest.mocked(backend.runners).mock.calls.length
    await expect(reconcile()).rejects.toThrow('retirement pending')
    expect(jest.mocked(backend.runners).mock.calls).toHaveLength(opened)
    await reconcile()
    expect(jest.mocked(backend.runners).mock.calls.length).toBeGreaterThan(opened)
  })
})
