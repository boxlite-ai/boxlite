/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { inspectJournal } from '../../tests/journal'
import { testCapacity } from '../../tests/capacity'
import { executeWorkerBootstrap } from '../../tests/worker-bootstrap'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitHubRequestError } from '../github'
import { GitHubRunners, JitRegistration, RunnerIdentity } from '../runners'
import { Json, LeaseLost, StateConflict, StateCorrupt } from '../state/database'
import { ExecutionLease, ListenerState } from '../state/store'
import { SqliteStateDatabase } from '../state/sqlite'
import { ConfirmedWorkerAbsent, ConfirmedWorkerCreationRejected, WorkerState } from '../worker'
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
  it.each(['new', 'existing'])('retries a rejected %s reservation during poll backoff', async (origin) => {
    const [check] = await state.read(['journal/format'], lease)
    const target = {
      id: 9,
      labels: ['boxlite'],
      held: 0,
      assigned: 1,
      check,
      delivery: { covered: 0, waitingForDispatch: true, offline: true },
    }
    if (origin === 'existing')
      await journal.reserve(lease, key, null, limits, { labels: target.labels, scaleSet: target.id })
    jest.mocked(backend.workers.create).mockImplementationOnce(async ({ name }) => {
      const row = await byName(name)
      throw new ConfirmedWorkerCreationRejected(row.value.effect!.id, 'before-persistence', 503)
    })
    const balance = () => pool.balanceScaleSets(lease, [target], limits, new AbortController().signal)
    await balance()
    expect(await journal.used(definition.organization)).toBe(0)
    expect(pool.creationReady('boxlite')).toBe(false)
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000)
    try {
      await balance()
      expect(backend.workers.create).toHaveBeenCalledTimes(2)
      expect(boxes.size).toBe(1)
    } finally {
      clock.mockRestore()
    }
  })
  describe.each([0, 1])('one offline assignment with two reservations and rejected journal row %i', (rejectedIndex) => {
    it.each(['queued', 'worked'])('retries only unserved demand when the other reservation is %s', async (other) => {
      const [check] = await state.read(['journal/format'], lease)
      const target = {
        id: 9,
        labels: ['boxlite'],
        held: 0,
        assigned: 1,
        check,
        delivery: { covered: 0, waitingForDispatch: true, offline: true },
      }
      const capacity = testCapacity({ account: 2, tenant: 2 })
      for (let i = 0; i < 2; i++)
        await journal.reserve(lease, key, null, capacity, { labels: target.labels, scaleSet: 9 })
      const {
        rows: [first, second],
      } = await journal.workers(lease, key, '')
      const [rejected, alternative] = rejectedIndex === 0 ? [first, second] : [second, first]
      const effect = randomUUID()
      await journal.advance(lease, rejected.record.key, rejected.record.version, {
        box: { phase: 'requested', id: null },
        effect: { id: effect, kind: 'box-create' },
      })
      if (other === 'worked') {
        await journal.advance(lease, alternative.record.key, alternative.record.version, {
          box: { phase: 'requested', id: null },
          effect: { id: randomUUID(), kind: 'box-create' },
        })
        boxes.set(alternative.value.name, { box_id: 'surviving-box', status: 'running' })
        known.add(alternative.value.name)
      }
      const get = jest.mocked(backend.workers.get).getMockImplementation()!
      jest.mocked(backend.workers.get).mockImplementation(async (name, ...args) => {
        if (name === rejected.value.name) throw new ConfirmedWorkerCreationRejected(effect, 'before-persistence', 503)
        return get(name, ...args)
      })
      const balance = () => pool.balanceScaleSets(lease, [target], capacity, new AbortController().signal)
      await balance()
      if (other === 'worked') {
        const row = await byName(alternative.value.name)
        expect(row.value.delivery).toBe('done')
        await journal.advance(lease, row.record.key, row.record.version, {
          runner: { ...row.value.runner, worked: true },
        })
        await finishBox()
      }
      expect(await journal.used(definition.organization)).toBe(0)
      const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 3000)
      try {
        await balance()
        expect(backend.workers.create).toHaveBeenCalledTimes(other === 'queued' ? 1 : 0)
      } finally {
        clock.mockRestore()
      }
    })
  })
  it('replaces an offline Box that exited before runner registration', async () => {
    const [check] = await state.read(['journal/format'], lease)
    const target = {
      id: 9,
      labels: ['boxlite'],
      assigned: 1,
      held: 0,
      check,
      delivery: { covered: 0, waitingForDispatch: true, offline: true },
    }
    const create = jest.mocked(backend.workers.create).getMockImplementation()!
    jest.mocked(backend.workers.create).mockImplementationOnce(async (launch) => {
      const result = await create(launch)
      boxes.get(launch.name)!.status = 'stopped'
      return result
    })
    const balance = () => pool.balanceScaleSets(lease, [target], limits, new AbortController().signal)
    await balance()
    await reconcile()
    expect(await journal.used(definition.organization)).toBe(0)
    expect(backend.workers.deliverJit).not.toHaveBeenCalled()
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 3000)
    try {
      await balance()
      expect(backend.workers.deliverJit).toHaveBeenCalledTimes(1)
    } finally {
      clock.mockRestore()
    }
  })
  it('keeps a held slot undispatched after its offline peer finished the last assignment', async () => {
    const [check] = await state.read(['journal/format'], lease)
    const target = {
      id: 9,
      labels: ['boxlite'],
      assigned: 1,
      held: 1,
      check,
      delivery: { covered: 0, waitingForDispatch: true, offline: true },
    }
    const capacity = testCapacity({ account: 2, tenant: 2 })
    for (let i = 0; i < 2; i++)
      await journal.reserve(lease, key, null, capacity, { labels: target.labels, scaleSet: 9 })
    const balance = () => pool.balanceScaleSets(lease, [target], capacity, new AbortController().signal)
    await balance()
    expect(boxes.size).toBe(1)
    const worker = await byName([...boxes.keys()][0])
    await journal.advance(lease, worker.record.key, worker.record.version, {
      runner: { ...worker.value.runner, worked: true },
    })
    await finishBox()
    await balance()
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
    expect(await journal.used(definition.organization)).toBe(1)
  })
  it.each(['replace', 'unknown'] as const)(
    'accounts for the hosted JIT recovery verdict %s during an outage',
    async (verdict) => {
      const [check] = await state.read(['journal/format'], lease)
      const target = {
        id: 9,
        labels: ['boxlite'],
        assigned: 1,
        held: 0,
        check,
        delivery: { covered: 0, waitingForDispatch: true, offline: true },
      }
      const balance = () => pool.balanceScaleSets(lease, [target], limits, new AbortController().signal)
      loseDelivery = true
      await expect(balance()).rejects.toThrow('lost upload acknowledgement')
      const row = await allocation()
      boxes.get(row.value.name)!.recoverableJit = true
      backend.workers.recoverJit = jest.fn(async () => verdict)
      const now = Date.now()
      const clock = jest.spyOn(Date, 'now').mockReturnValue(now)
      try {
        await reconcile()
        expect(backend.workers.recoverJit).toHaveBeenCalledTimes(1)
        await finishBox()
        expect(await journal.used(definition.organization)).toBe(0)
        loseDelivery = false
        await balance()
        expect(backend.workers.create).toHaveBeenCalledTimes(1)
        clock.mockReturnValue(now + 3000)
        await balance()
        expect(backend.workers.create).toHaveBeenCalledTimes(verdict === 'replace' ? 2 : 1)
      } finally {
        clock.mockRestore()
      }
    },
  )
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
  it.each([true, false])(
    'checks the original create effect before releasing a missing Box: matches=%s',
    async (matches) => {
      loseBox = true
      materializeBox = false
      await expect(tick()).rejects.toThrow('lost Box response')
      const original = await allocation()
      const effect = matches ? original.value.effect!.id : randomUUID()
      jest
        .mocked(backend.workers.get)
        .mockRejectedValueOnce(new ConfirmedWorkerAbsent({ boxId: 'original-box', effect }))
        .mockRejectedValueOnce(new ConfirmedWorkerAbsent())
      if (matches) {
        await reconcile()
        expect(events).toContainEqual(expect.objectContaining({ event: 'ci-worker-box-absent', boxId: 'original-box' }))
        expect(await journal.used(definition.organization)).toBe(0)
      } else {
        await expect(reconcile()).rejects.toBeInstanceOf(ConfirmedWorkerAbsent)
        expect((await allocation()).value.box.phase).toBe('requested')
        expect(await journal.used(definition.organization)).toBe(1)
      }
      expect(backend.workers.create).toHaveBeenCalledTimes(1)
    },
  )
  it.each([503, undefined])('backs off creation after host-confirmed rejection with status %s', async (status) => {
    jest.mocked(backend.workers.create).mockImplementationOnce(async ({ name }) => {
      const { value } = await byName(name)
      throw new ConfirmedWorkerCreationRejected(value.effect!.id, 'before-persistence', status)
    })
    await tick()
    expect(await journal.used(definition.organization)).toBe(0)
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'ci-worker-create-rejected',
        reason: 'before-persistence',
        ...(status === undefined ? {} : { platformStatus: status }),
      }),
    )
    expect(pool.creationReady('boxlite')).toBe(false)
    await tick()
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
  })
  it.each([new LeaseLost(), new StateCorrupt(), new StateConflict()])(
    'propagates %p before admitting any worker',
    async (cause) => {
      jest.mocked(backend.admit).mockRejectedValueOnce(cause)
      await expect(tick()).rejects.toBe(cause)
      expect(await journal.used(definition.organization)).toBe(0)
      expect(backend.workers.create).not.toHaveBeenCalled()
    },
  )
  it('keeps one shrink opportunity when REST and scale set membership disagree after DELETE', async () => {
    const capacity = testCapacity({ account: 3, tenant: 3 })
    const [check] = await state.read(['journal/format'], lease)
    const target = {
      id: 9,
      labels: ['boxlite'],
      assigned: 3,
      held: 0,
      check,
      delivery: { covered: 0, waitingForDispatch: true, offline: false },
    }
    const balance = () => pool.balanceScaleSets(lease, [target], capacity, new AbortController().signal)
    await balance()
    const deletions: string[] = []
    const open = backend.runners.bind(backend)
    backend.runners = async (guard, ...args) => {
      const session = await open(guard, ...args)
      session.registry.retireIdle = async (identity, signal, verify) => {
        // The scale-set membership lookup still sees A, even after REST stops finding it.
        const owned = await session.registry.lookup(identity, signal)
        if (!owned) throw Error('fixture lost membership')
        const repo = { id: 21, owner: { id: 7, login: 'owner' }, name: 'repo', private: true }
        const credential = {
          request: async (route: string, opts: { method?: string }) => {
            if (route === '/repositories/21') return repo
            if (opts?.method === 'DELETE') {
              deletions.push(identity.name)
              return
            }
            if (deletions.includes(identity.name)) throw new GitHubRequestError(404, false)
            return { ...identity, status: 'online', busy: false }
          },
        }
        const registry = new GitHubRunners(credential as never, definition.runners!, settings.labels, guard)
        return registry.retireKnownIdle(
          identity,
          async () => (identity.name === deletions[0] ? owned : null),
          signal,
          verify,
        )
      }
      return session
    }
    target.assigned = 2
    await expect(balance()).rejects.toThrow('not yet confirmed')
    const advanced = Date.now() + 61_000
    const clock = jest.spyOn(Date, 'now').mockReturnValue(advanced)
    try {
      await balance()
      await balance()
      expect(deletions).toHaveLength(1)
    } finally {
      clock.mockRestore()
    }
  })
  it('tries another original runner after a busy refusal and retires only the surplus', async () => {
    const capacity = testCapacity({ account: 3, tenant: 3 })
    const [check] = await state.read(['journal/format'], lease)
    const target = {
      id: 9,
      labels: ['boxlite'],
      assigned: 3,
      held: 0,
      check,
      delivery: { covered: 0, waitingForDispatch: true, offline: false },
    }
    const balance = () => pool.balanceScaleSets(lease, [target], capacity, new AbortController().signal)
    await balance()
    const open = backend.runners.bind(backend)
    const attempts: string[] = []
    const removed: string[] = []
    backend.runners = async (guard, ...args) => {
      const session = await open(guard, ...args)
      session.registry.retireIdle = async (identity) => {
        attempts.push(identity.name)
        if (identity.name === attempts[0]) return false
        await guard({ kind: 'remove', ...identity })
        runners.delete(identity.name)
        removed.push(identity.name)
        return true
      }
      return session
    }
    target.assigned = 2
    await balance() // The first candidate is busy.
    await balance() // Retire one idle runner and stop its Box.
    await balance() // Remove that stopped Box.
    await balance() // Observe its absence and release the slot.
    expect(new Set(attempts).size).toBe(2)
    expect(removed).toHaveLength(1)
    expect(runners.has(attempts[0])).toBe(true)
    expect(await journal.used(definition.organization)).toBe(2)
  })
  it('holds one shrink opportunity across a busy refusal and a pending DELETE', async () => {
    const capacity = testCapacity({ account: 3, tenant: 3 })
    const [check] = await state.read(['journal/format'], lease)
    const signal = new AbortController().signal
    const target = {
      id: 9,
      labels: ['boxlite'],
      assigned: 3,
      held: 0,
      check,
      delivery: { covered: 0, waitingForDispatch: true, offline: false },
    }
    await pool.balanceScaleSets(lease, [target], capacity, signal)
    const open = backend.runners.bind(backend)
    const started = new Set<string>()
    const requests: string[] = []
    let release!: () => void
    const response = new Promise<void>((resolve) => {
      release = resolve
    })
    backend.runners = async (guard, ...args) => {
      const session = await open(guard, ...args)
      session.registry.retireIdle = async (identity, _signal, verify) => {
        started.add(identity.name)
        if (started.size === 1) return false
        await guard({ kind: 'remove', ...identity })
        verify!()
        requests.push(identity.name)
        await response
        runners.delete(identity.name)
        return true
      }
      return session
    }
    const queue = new WorkQueue(3, jest.fn())
    const queued = new WorkerPool(journal, key, async () => backend, settings, observe, { queue, wake: () => {} })
    const balance = () => queued.balanceScaleSets(lease, [target], capacity, signal)
    // The queue also schedules passive recovery. Wait for each pass to settle those tasks.
    const idle = async (except?: string) => {
      const keys = [...(await rows()).allocations.keys()].filter((key) => key !== except)
      const until = Date.now() + 3000
      while (keys.some((key) => queue.revision(key)) && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 5))
      expect(keys.some((key) => queue.revision(key))).toBe(false)
    }
    try {
      target.assigned = 2
      await balance()
      await idle()
      expect(started.size).toBe(1)
      await balance()
      const deadline = Date.now() + 1500
      while (requests.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
      expect(requests).toHaveLength(1)
      const pending = await byName(requests[0])
      for (let pass = 0; pass < 2; pass++) {
        await balance()
        await idle(pending.record.key)
      }
      expect(started.size).toBe(2)
      expect(requests).toHaveLength(1)
      release()
      await idle()
      expect(runners.size).toBe(2)
    } finally {
      release()
      await queued.close()
      await queue.close()
    }
  })
  it('withdraws a running idle retirement before DELETE when fresh demand arrives', async () => {
    await tick()
    const original = await allocation()
    let started!: () => void, release!: () => void
    const startRetirement = new Promise<void>((resolve) => {
      started = resolve
    })
    const allowDeletion = new Promise<void>((resolve) => {
      release = resolve
    })
    const open = backend.runners.bind(backend)
    const remove = jest.fn()
    backend.runners = async (...args) => {
      const session = await open(...args)
      session.registry.retireIdle = async (runner, _signal, verify) => {
        await args[0]({ kind: 'remove', ...runner })
        started()
        await allowDeletion
        verify!()
        remove(runner)
        return true
      }
      return session
    }
    const queue = new WorkQueue(1, jest.fn())
    const queued = new WorkerPool(journal, key, async () => backend, settings, observe, { queue, wake: () => {} })
    const [check] = await state.read(['journal/format'], lease)
    const signal = new AbortController().signal
    try {
      await queued.balanceScaleSets(lease, [], limits, signal, check)
      await startRetirement
      expect((await allocation()).value.effect?.kind).toBe('runner-retire')
      const target = {
        id: 9,
        labels: ['boxlite'],
        assigned: 1,
        held: 0,
        check,
        delivery: { covered: 0, waitingForDispatch: true, offline: false },
      }
      await queued.balanceScaleSets(lease, [target], limits, signal)
      release()
      await queue.close()
      const retained = await allocation()
      expect(retained.value.effect).toEqual(original.value.effect)
      expect(retained.value.closing).toBe(false)
      expect(remove).not.toHaveBeenCalled()
      expect(backend.workers.stop).not.toHaveBeenCalled()
      expect(await journal.used(definition.organization)).toBe(1)
    } finally {
      release()
      await queue.close()
      await queued.close()
    }
  })
  it('detects a sibling reservation made after its own commit and reuses both slots on the next pass', async () => {
    const capacity = testCapacity({ account: 2, tenant: 2 })
    const supply = { labels: ['boxlite'], scaleSet: 9 }
    const [check] = await state.read(['journal/format'], lease)
    const target = {
      id: 9,
      labels: supply.labels,
      assigned: 2,
      held: 0,
      check,
      delivery: { covered: 0, waitingForDispatch: true, offline: false },
    }
    const balance = () => pool.balanceScaleSets(lease, [target], capacity, new AbortController().signal)
    const reserve = journal.reserve.bind(journal)
    jest.spyOn(journal, 'reserve').mockImplementationOnce(async (...args) => {
      const first = await reserve(...args)
      await reserve(lease, key, null, capacity, supply)
      return first
    })
    await expect(balance()).rejects.toBeInstanceOf(StateConflict)
    expect(await journal.used(definition.organization)).toBe(2)
    const workers = journal.workers.bind(journal)
    jest.spyOn(journal, 'workers').mockImplementation((epoch, scope, after) => workers(epoch, scope, after, 1))
    await balance()
    expect(backend.workers.create).toHaveBeenCalledTimes(2)
    expect(await journal.used(definition.organization)).toBe(2)
    expect(runners.size).toBe(2)
  })
  it.each([
    { job: { repository: 0, run: 33, job: 55 } },
    { job: { repository: 21, run: 0, job: 55 } },
    { job: { repository: 21, run: 33, job: 0 } },
    { job: false },
    { job: demand },
    { supply: { labels: ['boxlite'], scaleSet: 0 } },
    { supply: { labels: ['boxlite'] } },
    { runner: { phase: 'known', id: 91, worked: false } },
    { runner: { phase: 'none', id: null, worked: true } },
    { job: demand, supply: { labels: ['boxlite'] }, runner: { phase: 'known', id: 91, worked: true } },
  ])('rejects corrupt persisted worker identity before recovery: %j', async (damage) => {
    await tick()
    const row = await allocation()
    const payload = { ...row.value, ...damage } as unknown as Json
    await state.commit(lease, [{ key: row.record.key, expected: row.record.version, payload }])
    await expect(reconcile()).rejects.toBeInstanceOf(StateCorrupt)
    expect(backend.workers.create).toHaveBeenCalledTimes(1)
    expect(backend.workers.stop).not.toHaveBeenCalled()
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
  it('settles uncertain JIT delivery from observed work without uploading the configuration again', async () => {
    loseDelivery = true
    await expect(tick()).rejects.toThrow('lost upload acknowledgement')
    const row = await allocation()
    boxes.get(row.value.name)!.recoverableJit = true
    backend.workers.recoverJit = jest.fn(async () => 'delivered' as const)
    await journal.advance(lease, row.record.key, row.record.version, { runner: { ...row.value.runner, worked: true } })
    await reconcile()
    expect((await allocation()).value.delivery).toBe('done')
    expect(backend.workers.recoverJit).not.toHaveBeenCalled()
    expect(backend.workers.deliverJit).toHaveBeenCalledTimes(1)
  })
  it.each([true, false])('rechecks an uncertain retirement before stopping its Box: present=%s', async (present) => {
    await tick()
    const row = await allocation()
    await journal.advance(lease, row.record.key, row.record.version, {
      effect: { id: randomUUID(), kind: 'runner-retire' },
    })
    if (!present) runners.delete(row.value.name)
    await reconcile()
    const current = await allocation()
    expect(current.value.closing).toBe(!present)
    if (present) expect(backend.workers.stop).not.toHaveBeenCalled()
    else expect(backend.workers.stop).toHaveBeenCalledWith(row.value.name)
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
