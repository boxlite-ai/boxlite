/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { inspectJournal } from '../../tests/journal'
import { testCapacity } from '../../tests/capacity'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JitRegistration, RunnerIdentity } from '../runners'
import { LeaseLost, StateCorrupt } from '../state/database'
import { ExecutionLease, ListenerState } from '../state/store'
import { SqliteStateDatabase } from '../state/sqlite'
import { ConfirmedWorkerAbsent, ConfirmedWorkerCreationRejected, WorkerState } from '../worker'
import { ExecutionJournal } from './journal'
import { ExecutionScope } from './model'
import { PoolBackend, WorkerPool } from './pool'

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
  const supplyInventory = (busy = new Set<string>()) => {
    const inventory = jest.fn(async () =>
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
  it('counts idle supply and does not remint a runner for unchanged demand', async () => {
    supplyInventory()
    await pool.balance(lease, limits, countedDemand())
    await pool.balance(lease, limits, countedDemand())
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
    expect(backend.job).not.toHaveBeenCalled()
  })
  it('requires queue fallback before replacing busy supply without a running observation', async () => {
    const busy = new Set<string>()
    supplyInventory(busy)
    const capacity = testCapacity({ account: 2, tenant: 2 })
    await pool.balance(lease, capacity, countedDemand())
    busy.add((await allocation()).value.name)
    await expect(pool.balance(lease, capacity, countedDemand())).rejects.toThrow('without matching demand observations')
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
    await pool.balance(lease, capacity, countedDemand(), undefined, true)
    expect(backend.workers.create).toHaveBeenCalledTimes(2)
  })
  it('does not let cleanup occupy supply for pending label demand', async () => {
    supplyInventory()
    const capacity = testCapacity({ account: 2, tenant: 2 })
    await pool.balance(lease, capacity, countedDemand())
    const row = await allocation()
    await journal.advance(lease, row.record.key, row.record.version, { closing: true })
    await pool.balance(lease, capacity, countedDemand())
    expect(backend.workers.create).toHaveBeenCalledTimes(2)
    expect(backend.workers.stop).toHaveBeenCalledTimes(1)
  })
  it('rejects a renamed known runner before using it as supply', async () => {
    const inventory = supplyInventory()
    await pool.balance(lease, limits, countedDemand())
    inventory.mockImplementation(async () =>
      [...runners.values()].map((runner) => ({
        ...runner,
        name: 'another-runner',
        busy: false,
        status: 'online',
        labels: [...settings.labels],
      })),
    )
    await expect(pool.balance(lease, limits, countedDemand())).rejects.toBeInstanceOf(StateCorrupt)
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
  })
  it('rejects incompatible advertised supply labels rather than borrowing another profile', async () => {
    const inventory = supplyInventory()
    await pool.balance(lease, limits, countedDemand())
    inventory.mockImplementation(async () =>
      [...runners.values()].map((runner) => ({
        ...runner,
        busy: false,
        status: 'online',
        labels: ['boxlite-4vcpu-8gbmem-20gbdisk'],
      })),
    )
    await expect(pool.balance(lease, limits, countedDemand())).rejects.toBeInstanceOf(StateCorrupt)
  })
  it('withholds creation for dirty counts and unsupported requested labels', async () => {
    supplyInventory()
    await expect(pool.balance(lease, limits, [{ ...countedDemand()[0], dirty: true }])).rejects.toBeInstanceOf(
      StateCorrupt,
    )
    await pool.balance(lease, limits, countedDemand(1, ['boxlite', 'unsupported']))
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
    await pool.balance(lease, capacity, countedDemand(2))
    const allocations = [...(await rows()).allocations.values()]
    expect(allocations.some((row) => row.value.box.phase === 'requested')).toBe(true)
    expect(allocations.some((row) => row.value.delivery === 'done')).toBe(true)
    await pool.balance(lease, capacity, countedDemand(2))
    expect(backend.workers.create).toHaveBeenCalledTimes(2)
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ event: 'ci-worker-recovery-deferred' })]))
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
  it('creation refusal regression: a definitive refusal returns capacity and permits the same queued demand', async () => {
    jest.mocked(backend.workers.create).mockImplementationOnce(async (launch) => {
      const row = await byName(launch.name)
      throw new ConfirmedWorkerCreationRejected(row.value.effect!.id)
    })
    await expect(tick()).resolves.toBeUndefined()
    expect((await rows()).allocations.size).toBe(0)
    expect((await rows()).workers).toHaveLength(0)
    expect(backend.runners).not.toHaveBeenCalled()
    expect(backend.workers.get).not.toHaveBeenCalled()
    await tick()
    expect((await rows()).allocations.size).toBe(1)
    expect(backend.workers.create).toHaveBeenCalledTimes(2)
    expect(backend.workers.deliverJit).toHaveBeenCalledTimes(1)
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
