/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { inspectJournal } from '../../tests/journal'
import { testCapacity } from '../../tests/capacity'
import { executeWorkerBootstrap } from '../../tests/worker-bootstrap'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JitRegistration, RunnerIdentity } from '../runners'
import { StateCorrupt } from '../state/database'
import { ExecutionLease, ListenerState } from '../state/store'
import { SqliteStateDatabase } from '../state/sqlite'
import { ConfirmedWorkerAbsent, WorkerState } from '../worker'
import { ExecutionJournal } from './journal'
import { ExecutionScope } from './model'
import { PoolBackend, WorkerPool } from './pool'
import { WorkQueue } from './work-queue'

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
  const tick = async () => {
    const [proof] = await state.read(['journal/format'], lease)
    const target = {
      id: 9,
      labels: ['boxlite'],
      held: 0,
      assigned: 1,
      check: proof,
      delivery: { covered: 0, waitingForDispatch: true, offline: false },
    }
    await pool.balanceScaleSets(lease, [target], limits, new AbortController().signal)
  }
  const reconcile = () => pool.balanceScaleSets(lease, [], limits, new AbortController().signal)
  it('reserves 32 confirmed jobs in one pass when the BoxLite account has 32 free slots', async () => {
    const [proof] = await state.read(['journal/format'], lease)
    const target = {
      id: 9,
      labels: ['boxlite'],
      held: 0,
      assigned: 32,
      check: proof,
      delivery: { covered: 0, waitingForDispatch: true, offline: false },
    }
    const capacity = { limits: [{ domain: 'organization' as const, maximum: 32 }] }
    await pool.balanceScaleSets(lease, [target], capacity, new AbortController().signal)
    expect(await journal.used(definition.organization)).toBe(32)
  })
  it('recovers a stopped worker while new admission is denied', async () => {
    await tick()
    const [box] = boxes.values()
    box.status = 'stopped'
    jest.mocked(backend.admit).mockRejectedValue(new Error('Admission revoked'))
    const [proof] = await state.read(['journal/format'], lease)
    const targets = [
      {
        id: 9,
        labels: ['boxlite'],
        held: 0,
        assigned: 2,
        check: proof,
        delivery: { covered: 0, waitingForDispatch: true, offline: false },
      },
    ]
    for (let i = 0; i < 2; i++) {
      await pool.balanceScaleSets(lease, targets, limits, new AbortController().signal).catch(() => {})
    }
    expect(boxes.size).toBe(0)
    expect(await journal.used(definition.organization)).toBe(0)
  })
  const finishBox = async () => {
    for (const box of boxes.values()) box.status = 'stopped'
    await reconcile()
    await reconcile()
  }
  it('uses each disconnected assignment once when quota frees during backoff', async () => {
    const [check] = await state.read(['journal/format'], lease)
    const target = {
      id: 9,
      labels: ['boxlite'],
      held: 0,
      assigned: 3,
      check,
      delivery: { covered: 0, waitingForDispatch: true, offline: true },
    }
    const capacity = { limits: [{ domain: 'organization' as const, maximum: 1 }] }
    const balance = () => pool.balanceScaleSets(lease, [target], capacity, new AbortController().signal)
    const completeJobs = async () => {
      for (const { record, value } of (await rows()).allocations.values()) {
        await journal.advance(lease, record.key, record.version, { runner: { ...value.runner, worked: true } })
      }
      await finishBox()
    }
    await balance()
    expect(await journal.used(definition.organization)).toBe(1)
    await completeJobs()
    capacity.limits[0].maximum = 3
    await balance()
    expect(await journal.used(definition.organization)).toBe(2)
    await completeJobs()
    await balance()
    expect(backend.workers.create).toHaveBeenCalledTimes(3)
    expect(await journal.used(definition.organization)).toBe(0)
  })
  it('dispatches the original slot after the execution queue was full during poll backoff', async () => {
    const queue = new WorkQueue(
      1,
      (error) => {
        throw error
      },
      1,
    )
    let unblock!: () => void
    const busy = new Promise<void>((resolve) => {
      unblock = resolve
    })
    queue.enqueue('busy', '1', () => busy)
    const pending = new WorkerPool(journal, key, async () => backend, settings, observe, { queue, wake: () => {} })
    const [check] = await state.read(['journal/format'], lease)
    const target = {
      id: 9,
      labels: ['boxlite'],
      held: 0,
      assigned: 1,
      check,
      delivery: { covered: 0, waitingForDispatch: true, offline: true },
    }
    const balance = () => pending.balanceScaleSets(lease, [target], limits, new AbortController().signal)
    try {
      await balance()
      expect(await journal.used(definition.organization)).toBe(1)
      expect(backend.workers.create).not.toHaveBeenCalled()
      expect(target.delivery.waitingForDispatch).toBe(true)
      unblock()
      await new Promise<void>((resolve) => setImmediate(resolve))
      await balance()
      await queue.close()
      await balance()
      expect(target.delivery.waitingForDispatch).toBe(false)
      expect(backend.workers.create).toHaveBeenCalledTimes(1)
      expect(await journal.used(definition.organization)).toBe(1)
    } finally {
      unblock()
      await queue.close()
      await pending.close()
    }
  })
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
          trigger: null,
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
})
