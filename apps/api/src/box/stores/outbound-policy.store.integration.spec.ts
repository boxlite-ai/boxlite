import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { createServer, Server, ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { Context } from '../../common/context/context'
import { Box } from '../entities/box.entity'
import { BoxLastActivity } from '../entities/box-last-activity.entity'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { RunnerState } from '../enums/runner-state.enum'
import { LockCode } from '../common/redis-lock.provider'
import { BoxStartAction } from '../managers/box-actions/box-start.action'
import { DONT_SYNC_AGAIN, SYNC_AGAIN } from '../managers/box-actions/box.action'
import { AddOrganizationActivationFacts1792490000000 } from '../../migrations/pre-deploy/1792490000000-add-organization-activation-facts-migration'
import { AddOutboundControl1794888000000 } from '../../migrations/pre-deploy/1794888000000-add-outbound-control-migration'
import { IndexBoxOrganizationForProxy1795000000000 } from '../../migrations/pre-deploy/1795000000000-index-box-organization-for-proxy-migration'
import { AddOutboundProxyRegistry1795000001000 } from '../../migrations/pre-deploy/1795000001000-add-outbound-proxy-registry-migration'
import { ExtendOutboundProxyRuntimeState1795153000000 } from '../../migrations/pre-deploy/1795153000000-extend-outbound-proxy-runtime-state-migration'
import { AddOutboundProxyAdmission1795663861000 } from '../../migrations/pre-deploy/1795663861000-add-outbound-proxy-admission-migration'
import { OutboundCommitUnknown, OutboundPolicyStore, outboundRecord, persistedOutbound } from './outbound-policy.store'
import { PostgresCommitProxy } from './tests/postgres-commit-proxy'
import { Runner } from '../entities/runner.entity'
import { RunnerOutboundControl, OutboundSnapshot } from '../runner-adapter/outbound-control'
import { OutboundPolicyCoordinator } from '../services/outbound-policy.coordinator'
import { BoxRepository } from '../repositories/box.repository'
import { ProxyCredentialCipher } from '../outbound-proxy/proxy-credential-cipher'
import { ProxyRegistryStore } from '../outbound-proxy/proxy-registry.store'
import { ManagedCommand, ManagedReceipt } from '../runner-adapter/protected-outbound'
import { ProtectedBootKey, ProtectedBootReceipt } from '../runner-adapter/protected-runner'
import { ManagedOutboundBootstrap } from '../services/managed-outbound-bootstrap'
import { ManagedOutboundCoordinator } from '../services/managed-outbound.coordinator'
import { settleTerminatedOutbound } from '../services/managed-outbound-reconciliation'
import { RunnerAdapter } from '../runner-adapter/runnerAdapter'
import { RunnerAdapterV0 } from '../runner-adapter/runnerAdapter.v0'
import { RunnerAdapterV2 } from '../runner-adapter/runnerAdapter.v2'
import { BoxService } from '../services/box.service'
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schema = `outbound_${process.pid}_${randomUUID().replaceAll('-', '')}`
const org = '00000000-0000-4000-8000-0000000000aa'
const runnerId = '00000000-0000-4000-8000-0000000000bb'
const candidate = { revision: 'candidate-b', policy: { mode: 'disabled' as const, allow_net: [] } }
const reserved = { version: 1 as const, revision: 'initial', pending: { expected: 'initial', candidate, runnerId } }

describeIfDatabase('durable outbound policy store (real PostgreSQL)', () => {
  let primary: DataSource
  let transport: DataSource
  let proxy: PostgresCommitProxy
  let store: OutboundPolicyStore
  let box: Box
  let ownsSchema = false
  let http: Server
  let live: OutboundSnapshot
  let writes: { expected: string; candidate: OutboundSnapshot }[]
  let onApply: (next: OutboundSnapshot) => Promise<void>
  let acknowledge: (next: OutboundSnapshot, response: ServerResponse) => void
  let runtimePhase: 'confirmed' | 'pending' | 'uncertain'
  let coordinator: OutboundPolicyCoordinator
  let control: (box: Box) => Promise<RunnerOutboundControl>

  beforeAll(async () => {
    if (!['127.0.0.1', 'localhost', '::1'].includes(process.env.DB_HOST))
      throw new Error('Requires loopback PostgreSQL')
    const options = {
      type: 'postgres' as const,
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema,
      entities: [Box, BoxLastActivity, Runner],
      synchronize: false,
      entitySkipConstructor: true,
      ssl: false as const,
      extra: { options: `-c search_path=${schema},public`, connectionTimeoutMillis: 3000, query_timeout: 10000 },
    }
    primary = await new DataSource(options).initialize()
    await primary.query(`CREATE SCHEMA "${schema}"`)
    ownsSchema = true
    await primary.synchronize()
    await primary.query('CREATE TABLE organization (id uuid PRIMARY KEY)')
    await primary.query('INSERT INTO organization VALUES ($1)', [org])
    await primary.transaction((manager) => new AddOrganizationActivationFacts1792490000000().up(manager.queryRunner))
    const migration = primary.createQueryRunner()
    try {
      await new IndexBoxOrganizationForProxy1795000000000().up(migration)
      await new AddOutboundProxyRegistry1795000001000().up(migration)
      await new ExtendOutboundProxyRuntimeState1795153000000().up(migration)
      await new AddOutboundProxyAdmission1795663861000().up(migration)
    } finally {
      await migration.release()
    }
    proxy = new PostgresCommitProxy(options.host, options.port)
    const port = await proxy.start()
    transport = await new DataSource({
      ...options,
      host: '127.0.0.1',
      port,
      extra: { ...options.extra, application_name: schema },
    }).initialize()
    store = new OutboundPolicyStore(transport)
  }, 20000)

  afterAll(async () => {
    if (transport?.isInitialized) await transport.destroy()
    if (proxy) await proxy.stop()
    if (primary?.isInitialized) {
      if (ownsSchema) await primary.query(`DROP SCHEMA "${schema}" CASCADE`)
      await primary.destroy()
    }
  })

  beforeEach(async () => {
    proxy.rejectConnections = false
    proxy.rejectAfterCut = false
    box = Object.assign(new Box('local', randomUUID()), {
      organizationId: org,
      osUser: 'boxlite',
      labels: {},
      runnerId,
      state: BoxState.STARTED,
      desiredState: BoxDesiredState.STARTED,
      pending: false,
    })
    await primary.getRepository(Box).insert(box)
    live = { revision: 'initial', policy: { mode: 'enabled', allow_net: [] } }
    writes = []
    onApply = async () => undefined
    runtimePhase = 'confirmed'
    acknowledge = (next, response) => {
      response.setHeader('ETag', `"${next.revision}"`)
      response.end(JSON.stringify(next.policy))
    }
    http = createServer((request, response) => {
      void (async () => {
        expect(request.headers.authorization).toBe('Bearer synthetic-secret')
        if (request.method === 'GET' && request.url.endsWith('/status')) {
          response.end(
            JSON.stringify({
              persisted: live,
              observed: { ...live, application_state: runtimePhase },
              application_state: runtimePhase,
              ...(runtimePhase === 'pending' ? { pending_revision: live.revision } : {}),
              capabilities: ['revision-v1'],
            }),
          )
          return
        }
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const next: OutboundSnapshot = {
          revision: request.headers['x-boxlite-outbound-revision'] as string,
          policy: JSON.parse(Buffer.concat(chunks).toString()),
        }
        const expected = request.headers['if-match'] as string
        writes.push({ expected, candidate: next })
        if (expected !== `"${live.revision}"`) {
          response.writeHead(412)
          response.end()
          return
        }
        await onApply(next)
        live = next
        acknowledge(next, response)
      })().catch((error) => {
        response.statusCode = 500
        response.end(JSON.stringify({ error: String(error) }))
      })
    })
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    const runner = {
      apiUrl: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
      apiKey: 'synthetic-secret',
    } as Runner
    control = async (locked) => new RunnerOutboundControl(runner, locked.id)
    coordinator = new OutboundPolicyCoordinator(store, control)
  })

  afterEach(async () => {
    proxy.rejectConnections = false
    proxy.rejectAfterCut = false
    http.closeAllConnections()
    await new Promise<void>((resolve) => http.close(() => resolve()))
    jest.restoreAllMocks()
  })

  it('reserves before bound startup and promotes on exact readback before releasing the gate', async () => {
    const registry = new ProxyRegistryStore(primary, new ProxyCredentialCipher(undefined), true)
    const bootstrap = new ManagedOutboundBootstrap(primary, registry)
    const name = `proxy-${randomUUID()}`
    await registry.create(org, { name, url: 'socks5://proxy.example.com' })
    await primary.transaction(async (manager) => {
      Object.assign(box, { state: BoxState.UNKNOWN, pending: true })
      await manager.update(Box, box.id, { state: BoxState.UNKNOWN, pending: true })
      await bootstrap.seed(manager, box, name)
    })
    const getPins = () =>
      primary.query('SELECT kind, revision, runtime_epoch FROM outbound_proxy_reference WHERE box_id = $1', [box.id])
    expect(await getPins()).toEqual([{ kind: 'pending', revision: 1, runtime_epoch: null }])
    let attested: ProtectedBootReceipt | undefined
    const epoch = 'protected-first-epoch'
    const start = jest.fn(async (_id: string, key: ProtectedBootKey, route: unknown) => {
      expect(route).toMatchObject({ scheme: 'socks5', host: 'proxy.example.com', port: 1080 })
      expect(outboundRecord(await store.read(box.id, org)).bootstrap.claim).toBeDefined()
      expect(await getPins()).toEqual([{ kind: 'pending', revision: 1, runtime_epoch: null }])
      attested = { key, epoch, outcome: 'confirmed' }
      throw new Error('Lost initial start receipt')
    })
    const release = jest.fn(async () => {
      expect(await getPins()).toEqual([{ kind: 'committed', revision: 1, runtime_epoch: epoch }])
      expect(outboundRecord(await store.read(box.id, org)).managed.epoch).toBe(epoch)
    })
    const adapter = {
      protectedBootstrap: {
        supportsProtectedBootstrap: async () => true,
        prepareProtectedBox: jest.fn(),
        startProtectedBox: start,
        readProtectedBoot: async () => attested,
        changeProtectedBootGate: release,
      },
    } as unknown as RunnerAdapter
    const placeholder = { image: 'test/image', metadata: {}, nested: false }
    expect(await bootstrap.start(box, adapter, placeholder)).toBe('pending')
    expect(release).not.toHaveBeenCalled()
    expect(await bootstrap.start(box, adapter, placeholder)).toBe('ready')
    expect(start).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
    expect(outboundRecord(await store.read(box.id, org)).bootstrap).toBeUndefined()
  })

  it('does not allocate the same protected placeholder again after losing its replies', async () => {
    const registry = new ProxyRegistryStore(primary, new ProxyCredentialCipher(undefined), true)
    const bootstrap = new ManagedOutboundBootstrap(primary, registry)
    const name = `proxy-${randomUUID()}`
    await registry.create(org, { name, url: 'socks5://proxy.example.com' })
    await primary.transaction(async (manager) => {
      Object.assign(box, { state: BoxState.UNKNOWN, pending: true })
      await manager.update(Box, box.id, { state: BoxState.UNKNOWN, pending: true })
      await bootstrap.seed(manager, box, name)
    })
    const prepare = jest.fn().mockRejectedValue(new Error('Runner placeholder replies lost'))
    const start = jest.fn()
    const destroy = jest.fn().mockRejectedValueOnce(new Error('Runner destroy reply lost')).mockResolvedValue(undefined)
    const adapter = {
      protectedBootstrap: {
        supportsProtectedBootstrap: async () => true,
        destroyProtectedPlaceholder: destroy,
        prepareProtectedBox: prepare,
        startProtectedBox: start,
      },
    } as unknown as RunnerAdapter
    const placeholder = { image: 'test/image', metadata: {}, nested: false }

    const original = await bootstrap.start(box, adapter, placeholder)
    // The periodic state reconciler may resume on a different Cloud process.
    const resumed = await new ManagedOutboundBootstrap(primary, registry).start(box, adapter, placeholder)

    expect(prepare).toHaveBeenCalledTimes(1)
    expect(start).not.toHaveBeenCalled()
    expect([original, resumed]).toEqual(['allocation-unconfirmed', 'allocation-unconfirmed'])
    expect(outboundRecord(await store.read(box.id, org)).managed).toBeUndefined()

    await primary.getRepository(Box).update(box.id, { state: BoxState.ERROR, desiredState: BoxDesiredState.DESTROYED })
    expect(await bootstrap.retire(box, adapter, 'destroy')).toBe(false)
    const attempt = outboundRecord(await store.read(box.id, org)).bootstrap.key.attempt_id
    await expect(registry.remove(org, name)).rejects.toMatchObject({ status: 409 })
    expect(await bootstrap.retire(box, adapter, 'destroy')).toBe(true)
    expect(destroy.mock.calls).toEqual([
      [box.id, attempt],
      [box.id, attempt],
    ])
    const cleaned = outboundRecord(await store.read(box.id, org))
    expect(cleaned.bootstrap).toBeUndefined()
    expect(cleaned.placeholderClosed).toEqual({ runnerId, attemptId: attempt })
    await registry.remove(org, name)
  })

  it('bounds the protected placeholder cleanup request', async () => {
    const adapter = Object.create(RunnerAdapterV0.prototype) as RunnerAdapterV0
    const attempt = randomUUID()
    const destroy = jest.fn().mockResolvedValue({ data: { box_id: box.id, attempt_id: attempt, state: 'closed' } })
    Object.defineProperties(adapter, {
      bootstrapApi: { value: { delete: destroy } },
    })
    await adapter.destroyProtectedPlaceholder(box.id, attempt)
    expect(destroy).toHaveBeenCalledWith(`/v1/boxes/${box.id}/network/outbound/bootstrap/allocation/${attempt}`, {
      timeout: 10_000,
    })
  })

  it.each([1, 2])('leaves a primary connection available during allocation with pool size %i', async (poolSize) => {
    const options = primary.options as PostgresConnectionOptions
    const limited = await new DataSource({
      ...options,
      poolSize,
      extra: { ...options.extra, connectionTimeoutMillis: 500 },
    }).initialize()
    const registry = new ProxyRegistryStore(limited, new ProxyCredentialCipher(undefined), true)
    const bootstrap = new ManagedOutboundBootstrap(limited, registry)
    const next = Object.assign(new Box('local', randomUUID()), {
      organizationId: org,
      osUser: 'boxlite',
      labels: {},
      runnerId,
      state: BoxState.UNKNOWN,
      desiredState: BoxDesiredState.STARTED,
      pending: true,
    })
    let enterFirst!: () => void
    let enterNext!: () => void
    let release!: () => void
    const allocateFirst = new Promise<void>((resolve) => (enterFirst = resolve))
    const allocateNext = new Promise<void>((resolve) => (enterNext = resolve))
    const held = new Promise<void>((resolve) => (release = resolve))
    const prepare = jest.fn(async (candidate: Box) => {
      if (candidate.id === box.id) enterFirst()
      else enterNext()
      await held
    })
    const adapter = {
      protectedBootstrap: {
        supportsProtectedBootstrap: async () => true,
        prepareProtectedBox: prepare,
        startProtectedBox: async (_id: string, key: ProtectedBootKey): Promise<ProtectedBootReceipt> => ({
          key,
          epoch: randomUUID(),
          outcome: 'confirmed',
        }),
        changeProtectedBootGate: async () => undefined,
      },
    } as unknown as RunnerAdapter
    const placeholder = { image: 'test/image', metadata: {}, nested: false }
    const starts: Promise<unknown>[] = []

    try {
      await primary.transaction(async (manager) => {
        Object.assign(box, { state: BoxState.UNKNOWN, pending: true })
        await manager.update(Box, box.id, { state: BoxState.UNKNOWN, pending: true })
        await manager.insert(Box, next)
        await bootstrap.seed(manager, box, null)
        await bootstrap.seed(manager, next, null)
      })

      const first = bootstrap.start(box, adapter, placeholder)
      starts.push(first)
      await Promise.race([allocateFirst, first])
      await expect(limited.query('SELECT 1 AS available')).resolves.toEqual([{ available: 1 }])
      const second = bootstrap.start(next, adapter, placeholder)
      starts.push(second)
      await Promise.race([allocateNext, second])

      await expect(limited.query('SELECT 1 AS available')).resolves.toEqual([{ available: 1 }])
      expect(prepare).toHaveBeenCalledTimes(1)
      expect(await second).toBe('pending')
      release()
      expect(await first).toBe('ready')
      expect(await bootstrap.start(next, adapter, placeholder)).toBe('ready')
      expect(prepare.mock.calls.map(([candidate]) => candidate.id)).toEqual([box.id, next.id])
    } finally {
      release()
      await Promise.allSettled(starts)
      await limited.destroy()
    }
  })

  it.each(['allocate', 'handoff'])('recovers a due %s without accepting a delayed startup', async (phase) => {
    const registry = new ProxyRegistryStore(primary, new ProxyCredentialCipher(undefined), true)
    const bootstrap = new ManagedOutboundBootstrap(primary, registry)
    const name = `proxy-${randomUUID()}`
    await registry.create(org, { name, url: 'socks5://proxy.example.com' })
    await primary.transaction(async (manager) => {
      Object.assign(box, { state: BoxState.UNKNOWN, pending: true })
      await manager.update(Box, box.id, { state: BoxState.UNKNOWN, pending: true })
      await bootstrap.seed(manager, box, name)
    })
    const closed = new Set<string>()
    const nativeCreate = jest.fn()
    const prepare = jest.fn(
      async (_box: Box, _image: string, _metadata: unknown, _nested: boolean, attempt: string) => {
        if (closed.has(attempt)) throw new Error('Runner rejected the closed attempt')
        nativeCreate()
      },
    )
    const start = jest.fn()
    const destroy = jest.fn(async (_id: string, attempt: string) => {
      closed.add(attempt)
    })
    const adapter = {
      protectedBootstrap: {
        supportsProtectedBootstrap: async () => true,
        destroyProtectedPlaceholder: destroy,
        prepareProtectedBox: prepare,
        startProtectedBox: start,
        readProtectedBoot: jest.fn().mockRejectedValue(new Error('No Runner boot was published')),
      },
    } as unknown as RunnerAdapter
    const placeholder = { image: 'test/image', metadata: {}, nested: false }
    const allocationStore = Reflect.get(bootstrap, 'store') as OutboundPolicyStore
    const locked = allocationStore.locked.bind(allocationStore)
    let reserved!: () => void
    let resume!: () => void
    const reservationCommitted = new Promise<void>((resolve) => (reserved = resolve))
    const allowDispatch = new Promise<void>((resolve) => (resume = resolve))
    const pause = jest.spyOn(allocationStore, 'locked').mockImplementation(async (...args) => {
      const result = await locked(...args)
      if (
        (phase === 'allocate' &&
          result instanceof Box &&
          outboundRecord(result).bootstrap?.placeholderAllocation?.dispatchOwner) ||
        (phase === 'handoff' && result === true)
      ) {
        reserved()
        await allowDispatch
      }
      return result
    })
    const original = bootstrap.start(box, adapter, placeholder)
    try {
      await Promise.race([
        reservationCommitted,
        original.then(() => {
          throw new Error('Allocation completed before the reservation barrier')
        }),
      ])
      const allocation = outboundRecord(await store.read(box.id, org)).bootstrap?.placeholderAllocation
      const deadline = phase === 'handoff' ? allocation?.handoffDeadline : allocation?.deadline
      expect(deadline).toBeDefined()
      await primary.query(`UPDATE box SET "outboundControlDueAt" = now() WHERE id = $1`, [box.id])
      expect(await store.claimManagedWork()).toContainEqual({ id: box.id, organizationId: org })
      const clock = jest.spyOn(Date, 'now').mockReturnValue(deadline! + 1)
      try {
        const replacement = new ManagedOutboundBootstrap(primary, registry)
        expect(await replacement.reconcileAllocation(box, adapter)).toBe('allocation-unconfirmed')
        expect((await store.read(box.id, org)).state).toBe(BoxState.ERROR)
        await primary
          .getRepository(Box)
          .update(box.id, { state: BoxState.ERROR, desiredState: BoxDesiredState.DESTROYED })
        expect(await replacement.hasClosedAllocation(box)).toBe(true)
      } finally {
        clock.mockRestore()
      }
      expect(destroy).toHaveBeenCalledWith(box.id, expect.any(String))
    } finally {
      resume()
      await original
      pause.mockRestore()
    }
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(nativeCreate).toHaveBeenCalledTimes(phase === 'allocate' ? 0 : 1)
    expect(start).not.toHaveBeenCalled()
    expect(outboundRecord(await store.read(box.id, org)).bootstrap).toBeUndefined()
    await registry.remove(org, name)
  })

  it('retires an expired startup record before closing its exact allocation', async () => {
    const registry = new ProxyRegistryStore(primary, new ProxyCredentialCipher(undefined), true)
    const bootstrap = new ManagedOutboundBootstrap(primary, registry)
    const name = `proxy-${randomUUID()}`
    await registry.create(org, { name, url: 'socks5://proxy.example.com' })
    await primary.transaction(async (manager) => {
      Object.assign(box, { state: BoxState.UNKNOWN, pending: true })
      await manager.update(Box, box.id, { state: BoxState.UNKNOWN, pending: true })
      await bootstrap.seed(manager, box, name)
    })
    const epoch = 'failed-before-spawn'
    let removed = false
    const close = jest.fn(async () => {
      if (!removed) throw new Error('Runtime boot record still owns the stopped allocation')
    })
    const retire = jest.fn(async (_id: string, key: ProtectedBootKey) => ({ key, epoch, outcome: 'retired' }))
    const remove = jest.fn(async () => {
      removed = true
    })
    const release = jest.fn()
    const adapter = {
      protectedBootstrap: {
        supportsProtectedBootstrap: async () => true,
        prepareProtectedBox: jest.fn().mockResolvedValue(undefined),
        startProtectedBox: jest.fn().mockRejectedValue(new Error('Boot failed before spawning the Guest')),
        readProtectedBoot: jest.fn().mockRejectedValue(new Error('Boot has no confirmation')),
        destroyProtectedPlaceholder: close,
        retireProtectedBoot: retire,
        removeRetiredEpoch: remove,
        changeProtectedBootGate: release,
      },
    } as unknown as RunnerAdapter
    expect(await bootstrap.start(box, adapter, { image: 'test/image', metadata: {}, nested: false })).toBe('pending')
    const intent = outboundRecord(await store.read(box.id, org)).bootstrap
    expect(intent.placeholderAllocation?.handoffDeadline).toBeDefined()
    await expect(registry.remove(org, name)).rejects.toMatchObject({ status: 409 })

    const clock = jest.spyOn(Date, 'now').mockReturnValue(intent.placeholderAllocation.handoffDeadline + 1)
    try {
      expect(await bootstrap.reconcileAllocation(box, adapter)).toBe('allocation-unconfirmed')
    } finally {
      clock.mockRestore()
    }
    expect(retire).toHaveBeenCalledWith(box.id, intent.key)
    expect(remove).toHaveBeenCalledWith(box.id, intent.key, epoch)
    expect(close.mock.calls).toEqual([
      [box.id, intent.key.attempt_id],
      [box.id, intent.key.attempt_id],
    ])
    expect(release).not.toHaveBeenCalled()
    const current = await store.read(box.id, org)
    expect(current.state).toBe(BoxState.ERROR)
    expect(outboundRecord(current).placeholderClosed).toEqual({ runnerId, attemptId: intent.key.attempt_id })
    await registry.remove(org, name)
  })

  it('resumes a stopped Box action after the managed gate release was committed', async () => {
    const registry = new ProxyRegistryStore(primary, new ProxyCredentialCipher(undefined), true)
    const bootstrap = new ManagedOutboundBootstrap(primary, registry)
    const volumes = [{ volumeId: 'durable-volume', mountPath: '/data', subpath: 'logs' }]
    await primary.getRepository(Box).update(box.id, { state: BoxState.STOPPED, pending: false, volumes })
    const scheduled = await primary.transaction((manager) => bootstrap.legacyRestartIntent(manager, box))
    expect(scheduled?.bootstrap?.restart).toBe(true)
    await store.locked(box.id, org, ({ write }) => write(scheduled))
    await primary.getRepository(Box).update(box.id, { desiredState: BoxDesiredState.STARTED, pending: true })
    const epoch = 'released-restart-epoch'
    const key = scheduled.bootstrap.key
    const confirmed = { key, epoch, outcome: 'confirmed' }
    const start = jest.fn().mockResolvedValue(confirmed)
    const release = jest.fn().mockResolvedValue(undefined)
    const read = jest.fn().mockResolvedValue({ ...confirmed, epoch: 'stale-epoch' })
    const startBox = jest.fn()
    const capabilities = jest.fn(async (_recovery: boolean, volumeRestart: boolean) => !volumeRestart)
    const adapter = {
      startBox,
      boxInfo: jest.fn().mockResolvedValue({ state: BoxState.STARTED }),
      protectedBootstrap: {
        supportsProtectedBootstrap: capabilities,
        startProtectedBox: start,
        changeProtectedBootGate: release,
        readProtectedBoot: read,
      },
    } as unknown as RunnerAdapter
    const cache = { invalidate: jest.fn(), invalidateOrgId: jest.fn() }
    const repository = new BoxRepository(primary, { emit: jest.fn() } as never, cache as never)
    const interrupted = new Error('worker interrupted before updating the Box state')
    jest.spyOn(repository, 'update').mockRejectedValueOnce(interrupted)
    const lock = new LockCode('restart')
    const action = new BoxStartAction(
      { findOneOrFail: jest.fn().mockResolvedValue({ id: runnerId, state: RunnerState.READY }) } as never,
      { create: jest.fn().mockResolvedValue(adapter) } as never,
      repository,
      { findOne: jest.fn().mockResolvedValue(undefined) } as never,
      {} as never,
      { getCode: jest.fn().mockResolvedValue(lock) } as never,
      {} as never,
      {} as never,
      bootstrap,
    )

    expect(await action.run(await store.read(box.id, org), lock)).toBe(DONT_SYNC_AGAIN)
    expect(outboundRecord(await store.read(box.id, org)).bootstrap.claim).toBeUndefined()
    expect(start).not.toHaveBeenCalled()

    capabilities.mockResolvedValue(true)
    await expect(action.run(await store.read(box.id, org), lock)).rejects.toThrow(interrupted)
    const afterRelease = await store.read(box.id, org)
    expect(afterRelease.state).toBe(BoxState.STOPPED)
    expect(outboundRecord(afterRelease).bootstrap).toBeUndefined()
    expect(outboundRecord(afterRelease).managed.epoch).toBe(epoch)
    expect(await action.run(afterRelease, lock)).toBe(DONT_SYNC_AGAIN)
    expect((await store.read(box.id, org)).state).toBe(BoxState.STOPPED)

    read.mockResolvedValue(confirmed)
    const retry = await action.run(await store.read(box.id, org), lock)
    const starting = await store.read(box.id, org)
    expect(starting.state).toBe(BoxState.STARTING)
    expect(retry).toBe(SYNC_AGAIN)
    expect(read).toHaveBeenLastCalledWith(box.id, key, epoch)
    expect(await action.run(starting, lock)).toBe(DONT_SYNC_AGAIN)
    expect((await store.read(box.id, org)).state).toBe(BoxState.STARTED)
    expect(startBox).not.toHaveBeenCalled()
    expect(start).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledWith(box.id, key, null, scheduled.bootstrap.generation, true, volumes)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('drives bind, registry rotation and explicit unbind through one durable Cloud coordinator', async () => {
    const registry = new ProxyRegistryStore(primary, new ProxyCredentialCipher(undefined), true)
    const managedCoordinator = new ManagedOutboundCoordinator(primary, registry)
    const name = `proxy-${randomUUID()}`
    await registry.create(org, { name, url: 'https://proxy.example.com' })
    const epoch = 'managed-epoch'
    await store.locked(box.id, org, ({ write }) =>
      write({ version: 1, revision: live.revision, managed: { runnerId, epoch, binding: null } }),
    )
    let runtime: ManagedReceipt = {
      runner_id: runnerId,
      epoch,
      durable: { snapshot: live, binding: null },
      installed: { snapshot: live, binding: null },
      pending_attempt: null,
      unbind_settlement: null,
      rollback: null,
      retired_attempt: null,
    }
    let dropPrepareReply = false
    const agent = jest.fn(async (_epoch: string, command: ManagedCommand) => {
      expect(_epoch).toBe(epoch)
      if (command.operation === 'prepare') {
        const managed = outboundRecord(await store.read(box.id, org)).managed
        expect(managed.pending).toEqual(command.update)
        expect(managed.claim).toBeUndefined()
        runtime.pending_attempt = command.update.attempt_id
        if (dropPrepareReply) throw new Error('Controlled Runner acknowledgement loss')
      } else if (command.operation === 'apply') {
        const managed = outboundRecord(await store.read(box.id, org)).managed
        expect(managed.claim).toBeDefined()
        expect(managed.pending.attempt_id).toBe(command.attempt_id)
        expect(command.route?.binding ?? null).toEqual(managed.pending.candidate.binding)
        expect(command.predecessor_route?.binding ?? null).toEqual(managed.pending.predecessor.binding)
        runtime = {
          ...runtime,
          durable: managed.pending.candidate,
          installed: managed.pending.candidate,
          pending_attempt: null,
          unbind_settlement: command.route === null ? command.attempt_id : null,
        }
      } else if (command.operation === 'settle_unbind') {
        expect(outboundRecord(await store.read(box.id, org)).managed.unbindRelease.attemptId).toBe(command.attempt_id)
        runtime.unbind_settlement = null
      }
      return { ...runtime }
    })
    const protectedControl = async (b: Box) => Object.assign(await control(b), { managed: agent })
    const policy = { mode: 'enabled' as const, allow_net: ['packages.example.com'] }
    await expect(
      managedCoordinator.replace(box.id, org, policy, 'foreign-or-unknown', protectedControl),
    ).rejects.toMatchObject({ status: 404 })
    await expect(
      managedCoordinator.replace(box.id, org, policy, name, protectedControl, () => false),
    ).rejects.toMatchObject({ status: 412 })
    expect(agent.mock.calls.some(([, command]) => command.operation === 'apply')).toBe(false)
    const bound = await managedCoordinator.replace(box.id, org, policy, name, protectedControl)
    expect(outboundRecord(bound).managed.binding.registration_revision).toBe('1')
    runtime.proxy_diagnostic = 'proxy_timeout'
    expect((await managedCoordinator.status(box.id, org, protectedControl)).proxy).toHaveProperty(
      'diagnostic.code',
      'proxy_timeout',
    )
    for (const lock of ['LOCK TABLE box IN EXCLUSIVE MODE', 'SELECT id FROM box WHERE id = $1 FOR UPDATE']) {
      const holder = primary.createQueryRunner()
      try {
        await holder.startTransaction()
        await holder.query(lock, lock.startsWith('SELECT') ? [box.id] : [])
        const duringLock = await managedCoordinator.status(box.id, org, protectedControl)
        expect(duringLock.application_state).toBe('confirmed')
        expect(duringLock.proxy).not.toHaveProperty('diagnostic')
      } finally {
        if (holder.isTransactionActive) await holder.rollbackTransaction()
        await holder.release()
      }
    }
    const boundRecord = outboundRecord(bound)
    const binding = boundRecord.managed.binding
    const boundSnapshot = persistedOutbound(bound)
    const change = {
      attempt_id: 'diagnostic-race',
      predecessor: { snapshot: boundSnapshot, binding },
      candidate: { snapshot: { ...boundSnapshot, revision: 'diagnostic-next' }, binding },
    }
    const duringApply = await managedCoordinator.status(box.id, org, async (current) => {
      const existing = await protectedControl(current)
      return Object.assign(existing, {
        managed: async () => {
          await store.locked(box.id, org, ({ write }) =>
            write({ ...boundRecord, managed: { ...boundRecord.managed, pending: change } }),
          )
          return { ...runtime }
        },
      })
    })
    expect(duringApply.proxy).not.toHaveProperty('diagnostic')
    const beforeLegacyWrite = await store.read(box.id, org)
    const pinsBeforeLegacyWrite = await primary.query(
      'SELECT kind, revision, runtime_epoch FROM outbound_proxy_reference WHERE box_id = $1 ORDER BY kind',
      [box.id],
    )
    await expect(
      managedCoordinator.replace(box.id, org, { mode: 'disabled', allow_net: [] }, undefined, protectedControl),
    ).rejects.toMatchObject({ status: 409, response: { code: 'outbound_update_blocked' } })
    const afterLegacyWrite = await store.read(box.id, org)
    expect(outboundRecord(afterLegacyWrite)).toEqual(outboundRecord(beforeLegacyWrite))
    expect(persistedOutbound(afterLegacyWrite)).toEqual(persistedOutbound(beforeLegacyWrite))
    expect(
      await primary.query(
        'SELECT kind, revision, runtime_epoch FROM outbound_proxy_reference WHERE box_id = $1 ORDER BY kind',
        [box.id],
      ),
    ).toEqual(pinsBeforeLegacyWrite)
    await store.locked(box.id, org, ({ write }) => write(boundRecord))
    delete runtime.proxy_diagnostic
    await registry.update(org, name, { url: 'https://replacement.example.com', credential: null })
    const duringRollout = await managedCoordinator.status(box.id, org, protectedControl)
    expect(duringRollout.proxy).toEqual({
      desired: { name, revision: 2 },
      committed: { name, revision: 1 },
      pending: null,
      installed: { policy_revision: persistedOutbound(bound).revision, proxy: { name, revision: 1 } },
      runtime_readback: 'authenticated',
    })
    const stale = await managedCoordinator.status(box.id, org, async (b) =>
      Object.assign(await control(b), { managed: async () => ({ ...runtime, epoch: 'stale' }) }),
    )
    expect(stale.proxy.installed).toBeNull()
    expect(stale.proxy.runtime_readback).toBe('unknown')
    const offline = Array.from({ length: 32 }, () =>
      Object.assign(new Box('local', randomUUID()), {
        organizationId: org,
        osUser: 'boxlite',
        labels: {},
        runnerId,
        state: BoxState.STARTED,
        desiredState: BoxDesiredState.STARTED,
        pending: false,
        outboundControl: {
          version: 1 as const,
          revision: live.revision,
          managed: {
            runnerId,
            epoch: 'offline-epoch',
            binding: null,
            unbindRelease: { attemptId: 'offline-unbind', revision: live.revision },
          },
        },
      }),
    )
    const boxes = primary.getRepository(Box)
    await boxes.insert(offline)
    try {
      for (const { id, outboundControl } of offline) {
        await store.locked(id, org, ({ write }) => write(outboundControl, undefined, new Date(1)))
      }
      // The response was sampled from A. Commit B before returning that response to status.
      const oldReceipt: ManagedReceipt = { ...runtime, proxy_diagnostic: 'proxy_timeout' }
      const duringRotation = await managedCoordinator.status(box.id, org, async (current) => {
        const existing = await protectedControl(current)
        return Object.assign(existing, {
          managed: async () => {
            const attempted = new Set<string>()
            const errors = await managedCoordinator.poll(async (claimed) => {
              attempted.add(claimed.id)
              if (claimed.id !== box.id) throw new Error('offline Runner')
              return protectedControl(claimed)
            })
            expect(attempted.has(box.id)).toBe(true)
            expect(attempted.size).toBeLessThanOrEqual(16)
            expect(errors).toBe(attempted.size - 1)
            return oldReceipt
          },
        })
      })
      expect(duringRotation.proxy).not.toHaveProperty('diagnostic')
    } finally {
      await boxes.delete(offline.map(({ id }) => id))
    }
    const rotated = await store.read(box.id, org)
    expect(outboundRecord(rotated).managed.binding.registration_revision).toBe('2')
    expect(persistedOutbound(rotated).policy).toEqual(policy)
    expect((await managedCoordinator.status(box.id, org, protectedControl)).proxy).toMatchObject({
      installed: { policy_revision: persistedOutbound(rotated).revision, proxy: { name, revision: 2 } },
    })
    await managedCoordinator.replace(box.id, org, policy, null, protectedControl)
    expect(outboundRecord(await store.read(box.id, org)).managed.binding).toBeNull()
    expect(outboundRecord(await store.read(box.id, org)).managed.unbindRelease).toBeUndefined()
    await expect(registry.remove(org, name)).resolves.toBeUndefined()

    const committed = persistedOutbound(await store.read(box.id, org)).revision
    const stalePrecondition = (revision: string) => revision === persistedOutbound(rotated).revision
    await expect(
      managedCoordinator.replace(box.id, org, policy, null, protectedControl, stalePrecondition),
    ).rejects.toMatchObject({ status: 412 })

    dropPrepareReply = true
    await expect(managedCoordinator.replace(box.id, org, policy, null, protectedControl)).rejects.toMatchObject({
      status: 409,
      response: { code: 'outbound_application_unconfirmed' },
    })
    const pending = outboundRecord(await store.read(box.id, org)).managed.pending
    expect(pending.attempt_id).toBe(runtime.pending_attempt)
    await expect(
      managedCoordinator.replace(box.id, org, policy, null, protectedControl, stalePrecondition),
    ).rejects.toMatchObject({ status: 409, response: { code: 'outbound_update_blocked' } })
    const after = outboundRecord(await store.read(box.id, org))
    expect(after.revision).toBe(committed)
    expect(after.managed.pending).toEqual(pending)
  })

  it.each(['lost-prepare', 'lost', 'pending', 'wrong-proxy', 'wrong-epoch'] as const)(
    'settles managed replacement with %s acknowledgement evidence only when exact',
    async (fault) => {
      const registry = new ProxyRegistryStore(primary, new ProxyCredentialCipher(undefined), true)
      const managed = new ManagedOutboundCoordinator(primary, registry)
      const name = `proxy-${randomUUID()}`
      const epoch = 'managed-ack-epoch'
      await registry.create(org, { name, url: 'https://predecessor.example.com' })
      await store.locked(box.id, org, ({ write }) =>
        write({ version: 1, revision: live.revision, managed: { runnerId, epoch, binding: null } }),
      )

      let runtime: ManagedReceipt = {
        runner_id: runnerId,
        epoch,
        durable: { snapshot: live, binding: null },
        installed: { snapshot: live, binding: null },
        pending_attempt: null,
        unbind_settlement: null,
        rollback: null,
        retired_attempt: null,
      }
      let prepared: Extract<ManagedCommand, { operation: 'prepare' }>['update']
      let replacement = false
      const peer = jest.fn(async (_epoch: string, command: ManagedCommand) => {
        if (command.operation === 'prepare') {
          prepared = command.update
          runtime = { ...runtime, pending_attempt: prepared.attempt_id }
          if (replacement && fault === 'lost-prepare') {
            throw new Error('Controlled loss of the prepare acknowledgement')
          }
        }
        if (command.operation === 'apply') {
          const predecessor = runtime.durable
          const applied =
            replacement && fault === 'wrong-proxy'
              ? { ...prepared.candidate, binding: predecessor.binding }
              : prepared.candidate
          runtime = {
            ...runtime,
            epoch: replacement && fault === 'wrong-epoch' ? 'old-epoch' : epoch,
            durable: applied,
            installed: applied,
            pending_attempt: replacement && fault === 'pending' ? prepared.attempt_id : null,
          }
          if (replacement && (fault === 'lost' || fault === 'pending')) {
            throw new Error('Controlled loss of the apply acknowledgement')
          }
        }
        return runtime
      })
      const protectedControl = async (current: Box) => Object.assign(await control(current), { managed: peer })
      const original = await managed.replace(box.id, org, live.policy, name, protectedControl)
      await registry.update(org, name, { url: 'https://replacement.example.com' })
      replacement = true
      peer.mockClear()

      const replace = managed.replace(box.id, org, candidate.policy, name, protectedControl)
      if (fault === 'lost') {
        const settled = await replace
        expect(persistedOutbound(settled)).toEqual(runtime.durable.snapshot)
        expect(outboundRecord(settled).managed.pending).toBeUndefined()
      } else {
        await expect(replace).rejects.toMatchObject({
          status: 409,
          response: { code: 'outbound_application_unconfirmed' },
        })
        const held = await store.read(box.id, org)
        expect(persistedOutbound(held)).toEqual(persistedOutbound(original))
        expect(outboundRecord(held).managed.pending).toEqual(prepared)
      }
      expect(peer.mock.calls.filter(([, command]) => command.operation === 'apply')).toHaveLength(
        fault === 'lost-prepare' ? 0 : 1,
      )
      expect((await managed.status(box.id, org, protectedControl)).application_state).toBe(
        fault === 'lost' ? 'confirmed' : 'pending',
      )
      expect(
        await primary.query('SELECT kind, revision FROM outbound_proxy_reference WHERE box_id = $1 ORDER BY kind', [
          box.id,
        ]),
      ).toEqual(
        fault === 'lost'
          ? [{ kind: 'committed', revision: 2 }]
          : [
              { kind: 'committed', revision: 1 },
              { kind: 'pending', revision: 2 },
            ],
      )

      if (fault === 'lost-prepare') {
        const before = await store.read(box.id, org)
        const beforeReceipt = runtime
        const pinQuery = 'SELECT * FROM outbound_proxy_reference WHERE box_id = $1 ORDER BY kind'
        const beforePins = await primary.query(pinQuery, [box.id])
        await expect(managed.replace(box.id, org, candidate.policy, undefined, protectedControl)).rejects.toMatchObject(
          { status: 409, response: { code: 'outbound_update_blocked' } },
        )
        const after = await store.read(box.id, org)
        expect(outboundRecord(after)).toEqual(outboundRecord(before))
        expect(persistedOutbound(after)).toEqual(persistedOutbound(before))
        expect(await primary.query(pinQuery, [box.id])).toEqual(beforePins)
        expect(runtime).toEqual(beforeReceipt)
        expect(peer.mock.calls.filter(([, command]) => command.operation === 'apply')).toHaveLength(0)

        replacement = false
        const recovered = await managed.advance(box.id, org, protectedControl)
        expect(outboundRecord(recovered).managed.pending).toBeUndefined()
        expect(persistedOutbound(recovered)).toEqual(prepared.candidate.snapshot)
        expect(runtime.installed).toEqual(prepared.candidate)
      }
    },
  )

  it('settles due outbound work when PostgreSQL has only one connection available', async () => {
    const options = primary.options as PostgresConnectionOptions
    const limited = await new DataSource({
      ...options,
      poolSize: 1,
      extra: { ...options.extra, connectionTimeoutMillis: 500 },
    }).initialize()
    const originalEnabled = process.env.OUTBOUND_PROXY_REGISTRY_ENABLED
    try {
      const runner = Object.assign(
        new Runner({
          region: 'local',
          name: 'protected-runner',
          apiKey: 'fixture',
          apiVersion: '0',
          apiUrl: 'https://runner.test',
        }),
        { id: runnerId },
      )
      await primary.getRepository(Runner).insert(runner)
      const epoch = 'single-connection-epoch'
      const durable = { snapshot: persistedOutbound(box), binding: null }
      await store.locked(box.id, org, ({ write }) =>
        write(
          {
            version: 1,
            revision: durable.snapshot.revision,
            managed: {
              runnerId,
              epoch,
              binding: null,
              unbindRelease: { attemptId: 'unbind', revision: live.revision },
            },
          },
          undefined,
          new Date(1),
        ),
      )
      const registry = new ProxyRegistryStore(limited, new ProxyCredentialCipher(undefined), true)
      const service = Object.create(BoxService.prototype) as BoxService
      Object.assign(service, {
        outboundCoordinator: new ManagedOutboundCoordinator(limited, registry),
        runnerService: { findOne: (id: string) => limited.getRepository(Runner).findOneBy({ id }) },
        runnerAdapterFactory: {
          create: async () => ({
            managedOutbound: async (): Promise<ManagedReceipt> => ({
              runner_id: runnerId,
              epoch,
              durable,
              installed: durable,
              pending_attempt: null,
              unbind_settlement: null,
              rollback: null,
              retired_attempt: null,
            }),
          }),
        },
        logger: { warn: jest.fn() },
      })
      process.env.OUTBOUND_PROXY_REGISTRY_ENABLED = 'true'
      await service.reconcileManagedOutbound()
      expect(outboundRecord(await store.read(box.id, org)).managed.unbindRelease).toBeUndefined()
    } finally {
      if (originalEnabled === undefined) delete process.env.OUTBOUND_PROXY_REGISTRY_ENABLED
      else process.env.OUTBOUND_PROXY_REGISTRY_ENABLED = originalEnabled
      await limited.destroy()
    }
  })

  it.each(['restart', 'cleanup'])('checks prior Runner retirement before %s', async (outcome) => {
    const registry = new ProxyRegistryStore(primary, new ProxyCredentialCipher(undefined), true)
    const bootstrap = new ManagedOutboundBootstrap(primary, registry)
    const name = `proxy-${randomUUID()}`
    await registry.create(org, { name, url: 'https://old-proxy.example.com' })
    const epoch = 'old-epoch'
    const baseline = await registry.reserveBootstrapReference(
      {
        organizationId: org,
        boxId: box.id,
        runnerId,
        attemptId: 'old-start-attempt',
      },
      name,
    )
    await registry.confirmBootstrapReference(baseline, epoch)
    const key: ProtectedBootKey = {
      runner_id: runnerId,
      attempt_id: baseline.attemptId,
      registration_id: baseline.registrationId,
      registration_revision: '1',
      policy: live,
    }
    const binding = { epoch, registration_id: baseline.registrationId, registration_revision: '1' }
    const current = { snapshot: live, binding }
    await store.locked(box.id, org, ({ write }) =>
      write({
        version: 1,
        revision: live.revision,
        managed: { epoch, runnerId, binding, launch: { key, generation: 'old-gate' } },
      }),
    )
    const replacement = randomUUID()
    Object.assign(box, { runnerId: replacement, prevRunnerId: runnerId, state: BoxState.STARTING, pending: true })
    await primary.getRepository(Box).update(box.id, {
      runnerId: replacement,
      prevRunnerId: runnerId,
      state: BoxState.STARTING,
      pending: true,
    })
    await registry.update(org, name, { url: 'https://newer-proxy.example.com', credential: null })
    const exact = { key, epoch, outcome: 'retired' }
    const terminate = jest.fn().mockResolvedValue({ ...exact, epoch: 'unknown-epoch' })
    const remove = jest.fn(async () => {
      expect(outboundRecord(await store.read(box.id, org)).managed.retirement).toMatchObject({
        terminated: true,
        resolved: true,
      })
      return exact
    })
    const old = {
      stopBox: jest.fn(),
      protectedBootstrap: {
        sealProtectedEpoch: jest.fn().mockResolvedValue({
          durable: current,
          installed: current,
          pending: null,
          rollback: null,
          unbind_settlement: null,
          ordinary_pending: false,
        }),
        retireProtectedBoot: terminate,
        removeRetiredEpoch: remove,
      },
    } as unknown as RunnerAdapter
    expect(await bootstrap.retire(box, old, 'previous')).toBe(false)
    expect((await store.read(box.id, org)).prevRunnerId).toBe(runnerId)
    expect(remove).not.toHaveBeenCalled()
    await expect(registry.retireRevision(org, name, 1)).rejects.toMatchObject({ status: 409 })
    terminate.mockResolvedValue(exact)
    expect(await bootstrap.retire(box, old, 'previous')).toBe(true)
    expect((await store.read(box.id, org)).prevRunnerId).toBeNull()
    expect(remove).toHaveBeenCalledWith(box.id, key, epoch)
    if (outcome === 'cleanup') {
      const destroy = jest.fn().mockRejectedValueOnce(new Error('Lost cleanup reply')).mockResolvedValue(undefined)
      const start = jest.fn()
      const adapter = {
        protectedBootstrap: {
          supportsProtectedBootstrap: async () => true,
          destroyProtectedPlaceholder: destroy,
          prepareProtectedBox: jest.fn().mockRejectedValue(new Error('Lost replacement allocation replies')),
          startProtectedBox: start,
        },
      } as unknown as RunnerAdapter
      const placeholder = { image: 'test/image', metadata: {}, nested: false }
      expect(await bootstrap.start(await store.read(box.id, org), adapter, placeholder)).toBe('allocation-unconfirmed')
      expect(start).not.toHaveBeenCalled()
      await primary
        .getRepository(Box)
        .update(box.id, { state: BoxState.ERROR, desiredState: BoxDesiredState.DESTROYED })
      const current = await store.read(box.id, org)
      const pins = () =>
        primary.query('SELECT kind, runner_id FROM outbound_proxy_reference WHERE box_id = $1 ORDER BY kind', [box.id])
      expect(await bootstrap.retire(current, adapter, 'destroy')).toBe(false)
      expect(await pins()).toEqual([
        { kind: 'committed', runner_id: runnerId },
        { kind: 'pending', runner_id: replacement },
      ])
      expect(await bootstrap.retire(current, adapter, 'destroy')).toBe(true)
      expect(destroy.mock.calls).toEqual([
        [box.id, expect.any(String)],
        [box.id, destroy.mock.calls[0][1]],
      ])
      expect(await pins()).toEqual([])
      const cleared = outboundRecord(await store.read(box.id, org))
      expect(cleared.bootstrap).toBeUndefined()
      expect(cleared.managed).toBeUndefined()
      return
    }
    const nextEpoch = 'replacement-epoch'
    let allowRelease = false
    let deliveredReleases = 0
    const start = jest.fn(async (_id: string, next: ProtectedBootKey, route: unknown) => {
      expect(route).toMatchObject({ host: 'old-proxy.example.com' })
      expect(next.registration_revision).toBe('1')
      return { key: next, epoch: nextEpoch, outcome: 'confirmed' }
    })
    const release = jest.fn(async () => {
      const [pin] = await primary.query(
        'SELECT revision, runtime_epoch FROM outbound_proxy_reference WHERE box_id = $1',
        [box.id],
      )
      expect(pin).toEqual({ revision: 1, runtime_epoch: nextEpoch })
      if (!allowRelease) throw new Error('Controlled hold before sending gate release')
      deliveredReleases++
    })
    const adapter = {
      boxInfo: jest.fn().mockResolvedValue({ state: BoxState.STARTED }),
      protectedBootstrap: {
        supportsProtectedBootstrap: async () => true,
        prepareProtectedBox: jest.fn(),
        startProtectedBox: start,
        changeProtectedBootGate: release,
      },
    } as unknown as RunnerAdapter
    expect(await bootstrap.start(box, adapter, { image: 'test/image', metadata: {}, nested: false })).toBe('pending')
    const held = outboundRecord(await store.read(box.id, org))
    expect(held.bootstrap?.epoch).toBe(nextEpoch)
    expect(held.managed.epoch).toBe(nextEpoch)
    expect(release).toHaveBeenCalledWith(box.id, held.bootstrap.key, nextEpoch, held.bootstrap.generation, 'release', {
      snapshot: live,
      binding: held.managed.binding,
    })
    expect(deliveredReleases).toBe(0)

    const installed = { snapshot: live, binding: held.managed.binding }
    const inspect = jest.fn().mockResolvedValue({
      runner_id: replacement,
      epoch: nextEpoch,
      durable: installed,
      installed,
      pending_attempt: null,
      unbind_settlement: null,
      rollback: null,
      retired_attempt: null,
    } satisfies ManagedReceipt)
    const managedStatus = new ManagedOutboundCoordinator(primary, registry)
    const status = () =>
      managedStatus.status(box.id, org, async (locked) => Object.assign(await control(locked), { managed: inspect }))
    expect(await status()).toMatchObject({
      application_state: 'pending',
      proxy: { runtime_readback: 'unknown', installed: null, committed: { name, revision: 1 } },
    })
    expect(inspect).not.toHaveBeenCalled()

    const repository = new BoxRepository(
      primary,
      { emit: jest.fn() } as never,
      {
        invalidate: jest.fn(),
        invalidateOrgId: jest.fn(),
      } as never,
    )
    const lock = new LockCode('replacement')
    const action = new BoxStartAction(
      { findOneOrFail: async () => ({ id: replacement, state: RunnerState.READY }) } as never,
      { create: async () => adapter } as never,
      repository,
      {} as never,
      {} as never,
      { getCode: async () => lock } as never,
      {} as never,
      {} as never,
      bootstrap,
    )
    allowRelease = true
    expect(await action.run(await store.read(box.id, org), lock)).toBe(DONT_SYNC_AGAIN)
    const started = await store.read(box.id, org)
    expect(started.state).toBe(BoxState.STARTED)
    expect(outboundRecord(started).bootstrap).toBeUndefined()
    expect(start).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(2)
    expect(deliveredReleases).toBe(1)
    expect(await status()).toMatchObject({
      application_state: 'confirmed',
      proxy: {
        runtime_readback: 'authenticated',
        installed: { policy_revision: live.revision, proxy: { name, revision: 1 } },
      },
    })
    expect(inspect).toHaveBeenCalledWith(nextEpoch, { operation: 'inspect' })
  })

  it.each(['missing retirement receipt', 'irreconcilable sealed revisions'])(
    'does not dispatch a replacement with %s and retains both pinned versions',
    async (block) => {
      const registry = new ProxyRegistryStore(primary, new ProxyCredentialCipher(undefined), true)
      const bootstrap = new ManagedOutboundBootstrap(primary, registry)
      const name = `proxy-${randomUUID()}`
      const epoch = 'previous-epoch'
      const owner = { organizationId: org, boxId: box.id, runnerId }
      await registry.create(org, { name, url: 'https://old-proxy.example.com' })
      const original = await registry.reserveBootstrapReference({ ...owner, attemptId: 'old-start' }, name)
      await registry.confirmBootstrapReference(original, epoch)
      await registry.update(org, name, { url: 'https://candidate-proxy.example.com' })
      const next = await registry.reserveReference(
        { ...owner, runtimeEpoch: epoch, attemptId: 'unfinished-write' },
        name,
      )
      const binding = { epoch, registration_id: original.registrationId, registration_revision: '1' }
      const predecessor = { snapshot: live, binding }
      const pending = {
        attempt_id: next.attemptId,
        predecessor,
        candidate: { snapshot: candidate, binding: { ...binding, registration_revision: '2' } },
      }
      const key: ProtectedBootKey = {
        runner_id: runnerId,
        attempt_id: original.attemptId,
        registration_id: original.registrationId,
        registration_revision: '1',
        policy: live,
      }
      await store.locked(box.id, org, ({ write }) =>
        write({
          version: 1,
          revision: live.revision,
          managed: { runnerId, epoch, binding, pending, launch: { key, generation: 'previous-gate' } },
        }),
      )
      const replacement = randomUUID()
      await primary.getRepository(Box).update(box.id, {
        runnerId: replacement,
        prevRunnerId: runnerId,
        state: BoxState.STARTING,
        pending: true,
      })
      const pins = () =>
        primary.query(
          'SELECT kind, revision, runner_id, runtime_epoch FROM outbound_proxy_reference WHERE box_id = $1 ORDER BY kind',
          [box.id],
        )
      const before = await pins()
      expect(before).toEqual([
        { kind: 'committed', revision: 1, runner_id: runnerId, runtime_epoch: epoch },
        { kind: 'pending', revision: 2, runner_id: runnerId, runtime_epoch: epoch },
      ])
      const mismatch = block === 'irreconcilable sealed revisions'
      const unrelated = { snapshot: { ...live, revision: 'unrelated-revision' }, binding }
      const retire = mismatch
        ? jest.fn().mockResolvedValue({ key, epoch, outcome: 'retired' })
        : jest.fn().mockRejectedValue(new Error('Lost retirement receipt'))
      const seal = jest.fn().mockResolvedValue({
        durable: mismatch ? unrelated : predecessor,
        installed: mismatch ? unrelated : predecessor,
        pending: null,
        rollback: null,
        unbind_settlement: null,
        ordinary_pending: false,
      })
      const remove = jest.fn()
      const old = {
        stopBox: jest.fn().mockResolvedValue(undefined),
        protectedBootstrap: {
          sealProtectedEpoch: seal,
          retireProtectedBoot: retire,
          removeRetiredEpoch: remove,
        },
      }
      const previousRunner = { id: runnerId, state: RunnerState.READY }
      const findReplacement = jest.fn().mockResolvedValue({ id: replacement, state: RunnerState.READY })
      const replacementDispatch = jest.fn()
      const makeAdapter = jest.fn(({ id }) =>
        id === runnerId
          ? old
          : {
              createBox: replacementDispatch,
              startBox: replacementDispatch,
              protectedBootstrap: { prepareProtectedBox: replacementDispatch, startProtectedBox: replacementDispatch },
            },
      )
      const action = new BoxStartAction(
        { findOne: async () => previousRunner, findOneOrFail: findReplacement } as never,
        { create: makeAdapter } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        bootstrap,
      )

      expect(await action.run(await store.read(box.id, org), new LockCode('fenced-replacement'))).toBe(DONT_SYNC_AGAIN)
      expect(seal).toHaveBeenCalledWith(box.id, key, epoch, 'previous-gate')
      expect(retire).toHaveBeenCalledWith(box.id, key, epoch)
      expect(retire).toHaveBeenCalledTimes(mismatch ? 1 : 2)
      expect(remove).not.toHaveBeenCalled()
      expect(findReplacement).not.toHaveBeenCalled()
      expect(makeAdapter.mock.calls).toEqual([[previousRunner]])
      expect(replacementDispatch).not.toHaveBeenCalled()
      const fenced = await store.read(box.id, org)
      expect(fenced).toMatchObject({
        prevRunnerId: runnerId,
        runnerId: replacement,
        state: BoxState.STARTING,
        pending: true,
      })
      expect(outboundRecord(fenced).bootstrap).toBeUndefined()
      expect(outboundRecord(fenced).managed).toMatchObject({ pending, retirement: { terminated: mismatch } })
      expect(outboundRecord(fenced).managed.retirement.resolved).toBeUndefined()
      expect(await pins()).toEqual(before)
    },
  )

  it('holds a stopped bound Box on V2 without dispatching a legacy start job', async () => {
    jest.replaceProperty(process, 'env', { ...process.env, OUTBOUND_PROXY_REGISTRY_ENABLED: 'true' })
    const registry = new ProxyRegistryStore(primary, new ProxyCredentialCipher(undefined), true)
    const bootstrap = new ManagedOutboundBootstrap(primary, registry)
    const name = `proxy-${randomUUID()}`
    const epoch = 'bound-v0-epoch'
    await registry.create(org, { name, url: 'https://fixture-proxy.example.com' })
    const pin = await registry.reserveBootstrapReference(
      {
        organizationId: org,
        boxId: box.id,
        runnerId,
        attemptId: 'v0-binding',
      },
      name,
    )
    await registry.confirmBootstrapReference(pin, epoch)
    const binding = { epoch, registration_id: pin.registrationId, registration_revision: '1' }
    const key: ProtectedBootKey = {
      runner_id: runnerId,
      attempt_id: pin.attemptId,
      registration_id: pin.registrationId,
      registration_revision: '1',
      policy: live,
    }
    await store.locked(box.id, org, ({ write }) =>
      write({
        version: 1,
        revision: live.revision,
        managed: { runnerId, epoch, binding, launch: { key, generation: 'v0-generation' } },
      }),
    )
    const v2 = await primary.getRepository(Runner).save(
      Object.assign(new Runner({ region: box.region, name: 'bound-v2-fixture', apiVersion: '2', apiKey: 'fixture' }), {
        state: RunnerState.READY,
      }),
    )
    await primary.getRepository(Box).update(box.id, {
      runnerId: v2.id,
      state: BoxState.STOPPED,
      desiredState: BoxDesiredState.STOPPED,
      pending: false,
    })
    const pins = () =>
      primary.query('SELECT kind, revision, runner_id, runtime_epoch FROM outbound_proxy_reference WHERE box_id = $1', [
        box.id,
      ])
    const before = await pins()
    expect(before).toEqual([{ kind: 'committed', revision: 1, runner_id: runnerId, runtime_epoch: epoch }])

    const repository = new BoxRepository(
      primary,
      { emit: jest.fn() } as never,
      {
        invalidate: jest.fn(),
        invalidateOrgId: jest.fn(),
      } as never,
    )
    const createJob = jest.fn()
    const adapter = new RunnerAdapterV2(repository, {} as never, { createJob } as never)
    await adapter.init(v2)
    const findOne = jest.fn(async (id: string) => (id === v2.id ? v2 : undefined))
    const organizationService = { findOne: async () => undefined, assertOrganizationIsNotSuspended: jest.fn() }
    const runnerService = { findOne, findOneOrFail: findOne }
    const runnerAdapterFactory = { create: jest.fn().mockResolvedValue(adapter) }
    const service = Object.create(BoxService.prototype) as BoxService
    Object.assign(service, {
      boxRepository: repository,
      outboundBootstrap: bootstrap,
      runnerService,
      runnerAdapterFactory,
      organizationService,
      findOne: async () => Object.assign(await store.read(box.id, org), { runnerId }),
      regionService: { findOne: async () => ({ id: box.region }) },
      eventEmitter: { emit: jest.fn() },
    })
    const lock = new LockCode('v2-start')
    const action = new BoxStartAction(
      runnerService as never,
      runnerAdapterFactory as never,
      repository,
      organizationService as never,
      {} as never,
      { getCode: async () => lock } as never,
      {} as never,
      {} as never,
      bootstrap,
    )

    await expect(repository.conditionalStartForProxy(box.id, org)).rejects.toMatchObject({
      status: 503,
      diagnostic: 'runner_proxy_unsupported',
    })
    await expect(service.start(box.id, { id: org } as never, Context.user(), { idOnly: true })).rejects.toMatchObject({
      status: 503,
      diagnostic: 'runner_proxy_unsupported',
    })
    expect(await store.read(box.id, org)).toMatchObject({
      state: BoxState.STOPPED,
      desiredState: BoxDesiredState.STOPPED,
      pending: false,
    })
    expect(runnerAdapterFactory.create).not.toHaveBeenCalled()
    expect(service['eventEmitter'].emit).not.toHaveBeenCalled()
    expect(await pins()).toEqual(before)

    // Old pending intents can outlive a deployment. The worker still fences those.
    await primary.getRepository(Box).update(box.id, { desiredState: BoxDesiredState.STARTED, pending: true })
    expect(await action.run(await store.read(box.id, org), lock)).toBe(DONT_SYNC_AGAIN)
    expect(runnerAdapterFactory.create).toHaveBeenCalledWith(v2)
    expect(createJob).not.toHaveBeenCalled()
    const held = await store.read(box.id, org)
    expect(held).toMatchObject({ runnerId: v2.id, state: BoxState.STOPPED, pending: true })
    expect(outboundRecord(held).bootstrap).toBeUndefined()
    expect(outboundRecord(held).managed).toMatchObject({ runnerId, epoch, binding })
    expect(await pins()).toEqual(before)
  })

  it.each(['live', 'terminated'] as const)(
    'adopts an exact rollback token for a %s epoch and releases only the abandoned pin',
    async (epochState) => {
      const registry = new ProxyRegistryStore(primary, new ProxyCredentialCipher(undefined), true)
      const name = `proxy-${randomUUID()}`
      await registry.create(org, { name, url: 'https://proxy.example.com' })
      const owner = { organizationId: org, boxId: box.id, runnerId, runtimeEpoch: 'test-epoch' }
      const baseline = await registry.reserveBootstrapReference({ ...owner, attemptId: 'boot' }, name)
      await registry.confirmBootstrapReference(baseline, owner.runtimeEpoch)
      await registry.update(org, name, { url: 'https://new-proxy.example.com', credential: null })
      const abandoned = await registry.reserveReference({ ...owner, attemptId: 'failed-attempt' }, name)
      const binding = (reference: typeof baseline | typeof abandoned) => ({
        epoch: owner.runtimeEpoch,
        registration_id: reference.registrationId,
        registration_revision: String(reference.revision),
      })
      const predecessor = { snapshot: live, binding: binding(baseline) }
      const pending = {
        attempt_id: abandoned.attemptId,
        predecessor,
        candidate: { snapshot: candidate, binding: binding(abandoned) },
      }
      const restored = { ...predecessor, snapshot: { ...live, revision: 'restored-after-failure' } }
      await store.locked(box.id, org, async ({ write }) => {
        await write(
          {
            version: 1,
            revision: live.revision,
            managed: { runnerId, epoch: owner.runtimeEpoch, binding: predecessor.binding, pending },
          },
          undefined,
          new Date(),
        )
      })
      const proof: ManagedReceipt = {
        runner_id: runnerId,
        epoch: owner.runtimeEpoch,
        durable: restored,
        installed: restored,
        pending_attempt: null,
        unbind_settlement: null,
        rollback: { failed: pending, restored },
        retired_attempt: null,
      }
      const claimed = await Promise.all([store.claimManagedWork(), store.claimManagedWork()])
      expect(claimed.flat().filter(({ id }) => id === box.id)).toEqual([{ id: box.id, organizationId: org }])
      const managed = jest.fn().mockResolvedValue({ ...proof, epoch: 'stale-epoch' })
      const managedCoordinator = new OutboundPolicyCoordinator(store, async (record) =>
        Object.assign(await control(record), { managed }),
      )
      const replace = () => managedCoordinator.replace(box.id, org, candidate.policy)
      await expect(replace()).rejects.toMatchObject({ status: 409 })
      expect(outboundRecord(await store.read(box.id, org)).managed.pending).toEqual(pending)
      await expect(registry.retireRevision(org, name, baseline.revision)).rejects.toMatchObject({ status: 409 })
      managed.mockResolvedValue({ ...proof, installed: null })
      await expect(replace()).rejects.toMatchObject({ status: 409 })
      expect(outboundRecord(await store.read(box.id, org)).managed.pending).toEqual(pending)
      if (epochState === 'terminated') {
        await store.locked(box.id, org, ({ box: locked, write }) => {
          const record = outboundRecord(locked)
          return write({
            ...record,
            managed: {
              ...record.managed,
              retirement: {
                terminated: true,
                evidence: {
                  durable: restored,
                  installed: null,
                  pending: null,
                  ordinary_pending: false,
                  rollback: proof.rollback,
                  unbind_settlement: null,
                },
              },
            },
          })
        })
        expect(await store.locked(box.id, org, settleTerminatedOutbound)).toBe(true)
      } else {
        managed.mockResolvedValue(proof)
        await expect(replace()).rejects.toMatchObject({ status: 409 })
      }
      const settled = await store.read(box.id, org)
      expect(persistedOutbound(settled)).toEqual(restored.snapshot)
      expect(outboundRecord(settled).managed).toMatchObject({
        runnerId,
        epoch: owner.runtimeEpoch,
        binding: predecessor.binding,
      })
      expect(outboundRecord(settled).managed.pending).toBeUndefined()
      const pins = await primary.query('SELECT kind, revision FROM outbound_proxy_reference WHERE box_id = $1', [
        box.id,
      ])
      expect(pins).toEqual([{ kind: 'committed', revision: baseline.revision }])
      const [work] = await primary.query('SELECT "outboundControlDueAt" FROM box WHERE id = $1', [box.id])
      expect(work.outboundControlDueAt).toBeNull()
      if (epochState === 'terminated') return
      const statusCoordinator = new ManagedOutboundCoordinator(primary, registry)
      const staleSample: ManagedReceipt = {
        ...proof,
        installed: predecessor,
        durable: predecessor,
        proxy_diagnostic: 'proxy_timeout',
      }
      const readStatus = (receipt: ManagedReceipt) =>
        statusCoordinator.status(box.id, org, async (current) =>
          Object.assign(await control(current), { managed: async () => receipt }),
        )
      expect((await readStatus(staleSample)).proxy).not.toHaveProperty('diagnostic')
      const restoredStatus = await readStatus(proof)
      expect(restoredStatus.application_state).toBe('confirmed')
      expect(restoredStatus.proxy).not.toHaveProperty('diagnostic')
      expect(writes).toHaveLength(0)
    },
  )

  it('commits unbind before releasing its write fence, including a lost release receipt', async () => {
    const registry = new ProxyRegistryStore(primary, new ProxyCredentialCipher(undefined), true)
    const name = `proxy-${randomUUID()}`
    await registry.create(org, { name, url: 'https://proxy.example.com' })
    const epoch = 'unbind-epoch'
    const baseline = await registry.reserveBootstrapReference(
      {
        organizationId: org,
        boxId: box.id,
        runnerId,
        attemptId: 'boot-unbind',
      },
      name,
    )
    await registry.confirmBootstrapReference(baseline, epoch)
    const binding = { epoch, registration_id: baseline.registrationId, registration_revision: '1' }
    const pending = {
      attempt_id: 'pending-unbind',
      predecessor: { binding, snapshot: live },
      candidate: { binding: null, snapshot: candidate },
    }
    await store.locked(box.id, org, async ({ write }) => {
      await write(
        {
          version: 1,
          revision: live.revision,
          managed: { runnerId, epoch, binding, pending },
        },
        undefined,
        new Date(),
      )
    })
    const receipt: ManagedReceipt = {
      epoch,
      runner_id: runnerId,
      durable: pending.candidate,
      installed: pending.candidate,
      pending_attempt: null,
      unbind_settlement: pending.attempt_id,
      rollback: null,
      retired_attempt: null,
    }
    const managed = jest.fn(async (_epoch: string, command: { operation: string }) => {
      if (command.operation === 'settle_unbind') {
        receipt.unbind_settlement = null
        throw new Error('Lost settlement receipt')
      }
      return { ...receipt }
    })
    const managedCoordinator = new OutboundPolicyCoordinator(store, async (record) =>
      Object.assign(await control(record), { managed }),
    )
    const replace = () => managedCoordinator.replace(box.id, org, { mode: 'enabled', allow_net: [] })
    live = candidate

    await expect(replace()).rejects.toMatchObject({ status: 409 })
    expect(managed).toHaveBeenCalledTimes(1)
    expect(outboundRecord(await store.read(box.id, org)).managed.unbindRelease).toEqual({
      attemptId: pending.attempt_id,
      revision: candidate.revision,
    })
    await expect(replace()).rejects.toMatchObject({ status: 409 })
    expect(managed).toHaveBeenCalledWith(epoch, {
      operation: 'settle_unbind',
      attempt_id: pending.attempt_id,
      revision: candidate.revision,
    })
    expect(outboundRecord(await store.read(box.id, org)).managed.unbindRelease).toBeDefined()
    expect(writes).toHaveLength(0)

    await replace()
    expect(outboundRecord(await store.read(box.id, org)).managed).toEqual({ runnerId, epoch, binding: null })
    expect(writes).toHaveLength(1)
    await expect(registry.remove(org, name)).resolves.toBeUndefined()
  })

  it('expands and reverts the actual schema without rewriting existing policy', async () => {
    const runner = primary.createQueryRunner()
    const migration = new AddOutboundControl1794888000000()
    try {
      await migration.down(runner)
      await migration.up(runner)
      expect(persistedOutbound(await store.read(box.id, org))).toEqual({
        revision: 'initial',
        policy: { mode: 'enabled', allow_net: [] },
      })
    } finally {
      await runner.release()
    }
  })

  it('commits full pending intent before returning and hides it from ordinary loads', async () => {
    await store.locked(box.id, org, ({ write }) => write(reserved))
    const restarted = new OutboundPolicyStore(primary)
    expect(outboundRecord(await restarted.read(box.id, org))).toEqual(reserved)
    expect((await primary.getRepository(Box).findOneByOrFail({ id: box.id })).outboundControl).toBeUndefined()
    // An old lifecycle handle must not erase control metadata it did not load.
    const stale = await primary.getRepository(Box).findOneByOrFail({ id: box.id })
    stale.errorReason = 'lifecycle update'
    await primary.getRepository(Box).save(stale)
    expect(outboundRecord(await restarted.read(box.id, org))).toEqual(reserved)
  })

  it('publishes policy and revision together and rolls a failed callback back', async () => {
    await store.locked(box.id, org, async ({ write }) => {
      await write(reserved)
      await write({ version: 1, revision: candidate.revision }, candidate)
    })
    expect(persistedOutbound(await store.read(box.id, org))).toEqual(candidate)
    await expect(
      store.locked(box.id, org, async ({ write }) => {
        await write({ ...reserved, revision: candidate.revision })
        throw new Error('coordinator stopped before commit')
      }),
    ).rejects.toThrow('coordinator stopped')
    expect(outboundRecord(await store.read(box.id, org))).toEqual({ version: 1, revision: candidate.revision })
  })

  it('isolates organizations and rejects corrupt control instead of resetting to initial', async () => {
    await expect(store.read(box.id, randomUUID())).rejects.toThrow('Box not found')
    await expect(store.locked(box.id, randomUUID(), jest.fn())).rejects.toThrow('Box not found')
    await primary.getRepository(Box).update(box.id, { outboundControl: { version: 9 } as any })
    await expect(store.read(box.id, org)).rejects.toThrow('metadata is invalid')
  })

  it.each(['before', 'after'] as const)(
    'distinguishes durable outcome after a real %s-COMMIT socket cut',
    async (fault) => {
      const cuts = proxy.cuts
      proxy.arm(fault)
      await expect(store.locked(box.id, org, ({ write }) => write(reserved))).rejects.toBeInstanceOf(
        OutboundCommitUnknown,
      )
      expect(proxy.cuts).toBe(cuts + 1)
      // A new transaction after release observes server truth, independent of the lost reply.
      const record = await store.locked(box.id, org, async ({ box: recovered }) => outboundRecord(recovered))
      expect(record).toEqual(fault === 'before' ? { version: 1, revision: 'initial' } : reserved)
    },
  )

  it('reserves the full candidate durably before its real HTTP dispatch', async () => {
    onApply = async (next) => {
      const durable = outboundRecord(await new OutboundPolicyStore(primary).read(box.id, org))
      expect(durable).toEqual({
        version: 1,
        revision: 'initial',
        pending: { expected: 'initial', candidate: next, runnerId },
      })
    }
    const result = await coordinator.replace(box.id, org, candidate.policy)
    expect(writes).toHaveLength(1)
    expect(persistedOutbound(result)).toEqual(live)
    expect(outboundRecord(await store.read(box.id, org)).pending).toBeUndefined()
    expect(await coordinator.status(box.id, org)).toMatchObject({
      application_state: 'confirmed',
      persisted: live,
      runtime_persisted: live,
    })
  })

  it('exposes the persisted snapshot and guarded replacement through BoxRepository', async () => {
    const cache = { invalidate: jest.fn(), invalidateOrgId: jest.fn() }
    const repository = new BoxRepository(primary, { emit: jest.fn() } as never, cache as never)
    expect((await repository.readOutbound(box.id, org)).revision).toBe('initial')
    const result = await repository.replaceOutbound(
      box.id,
      org,
      candidate.policy,
      control,
      (revision) => revision === 'initial',
    )
    expect(persistedOutbound(result)).toEqual(live)
    expect((await repository.outboundStatus(box.id, org, control)).application_state).toBe('confirmed')
    await expect(repository.readOutbound(box.id, randomUUID())).rejects.toThrow('Box not found')
  })

  it('preserves confirmed policy and revision through real lifecycle updates using a stale entity', async () => {
    const cache = { invalidate: jest.fn(), invalidateOrgId: jest.fn() }
    const repository = new BoxRepository(primary, { emit: jest.fn() } as never, cache as never)
    const stale = await repository.findOneBy({ id: box.id })
    expect(stale.outboundControl).toBeUndefined()
    await coordinator.replace(box.id, org, candidate.policy)
    const confirmed = structuredClone(live)
    await repository.update(box.id, { entity: stale, updateData: { errorReason: 'lifecycle observation' } })
    await repository.updateWhere(box.id, {
      updateData: { errorReason: 'locked lifecycle observation' },
      whereCondition: { organizationId: org },
    })
    const durable = await store.read(box.id, org)
    expect(durable.errorReason).toBe('locked lifecycle observation')
    expect(persistedOutbound(durable)).toEqual(confirmed)
    expect(outboundRecord(durable)).toEqual({ version: 1, revision: confirmed.revision })
    expect((await coordinator.status(box.id, org)).application_state).toBe('confirmed')
    expect(writes).toHaveLength(1)
  })

  it.each([
    ['stopped', { state: BoxState.STOPPED }],
    ['stopping', { desiredState: BoxDesiredState.STOPPED }],
    ['unassigned', { runnerId: null }],
    ['transitioning', { pending: true }],
  ])('refuses a %s Box before contacting Runner', async (_name, patch) => {
    await primary.getRepository(Box).update(box.id, patch)
    await expect(coordinator.replace(box.id, org, candidate.policy)).rejects.toThrow('running box')
    expect(writes).toHaveLength(0)
    expect(outboundRecord(await store.read(box.id, org)).pending).toBeUndefined()
  })

  it.each(['before', 'after'] as const)(
    'recovers a %s-COMMIT reservation cut without unchecked dispatch',
    async (fault) => {
      proxy.arm(fault)
      if (fault === 'before') {
        await expect(coordinator.replace(box.id, org, candidate.policy)).rejects.toThrow(
          'reservation was not confirmed',
        )
        expect(writes).toHaveLength(0)
        expect(outboundRecord(await store.read(box.id, org)).pending).toBeUndefined()
      } else {
        const result = await coordinator.replace(box.id, org, candidate.policy)
        expect(writes).toHaveLength(1)
        expect(persistedOutbound(result)).toEqual(live)
      }
    },
  )

  it.each(['before', 'after'] as const)(
    'reconnects before deciding compensation after a %s-COMMIT finalization cut',
    async (fault) => {
      onApply = async () => {
        if (writes.length === 1) proxy.arm(fault)
      }
      if (fault === 'after') {
        const result = await coordinator.replace(box.id, org, candidate.policy)
        expect(persistedOutbound(result)).toEqual(live)
        expect(writes).toHaveLength(1)
      } else {
        await expect(coordinator.replace(box.id, org, candidate.policy)).rejects.toBeInstanceOf(OutboundCommitUnknown)
        expect(writes).toHaveLength(2)
        const [applied, restored] = writes
        expect(restored.expected).toBe(`"${applied.candidate.revision}"`)
        expect(restored.candidate.revision).not.toBe('initial')
        expect(restored.candidate.revision).not.toBe(applied.candidate.revision)
        expect(restored.candidate.policy).toEqual({ mode: 'enabled', allow_net: [] })
        expect(persistedOutbound(await store.read(box.id, org))).toEqual(restored.candidate)
      }
    },
  )

  it('preserves pending after coordinator loss, then fences a delayed old request', async () => {
    await store.locked(box.id, org, ({ write }) => write(reserved))
    expect(await coordinator.status(box.id, org)).toMatchObject({
      application_state: 'pending',
      pending_revision: candidate.revision,
    })
    expect(outboundRecord(await store.read(box.id, org))).toEqual(reserved)
    await expect(
      coordinator.replace(box.id, org, candidate.policy, (revision) => revision === 'initial'),
    ).rejects.toThrow('unresolved')
    expect(writes).toHaveLength(0)
    await coordinator.replace(box.id, org, { mode: 'enabled', allow_net: ['example.com'] })
    const winner = structuredClone(live)
    const runner = {
      apiUrl: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
      apiKey: 'synthetic-secret',
    } as Runner
    expect(await new RunnerOutboundControl(runner, box.id).replace('initial', candidate)).toBe('precondition_failed')
    expect(live).toEqual(winner)
  })

  it('reconciles an ACK-before-persistence crash before evaluating a stale public precondition', async () => {
    await store.locked(box.id, org, ({ write }) => write(reserved))
    live = candidate
    expect((await coordinator.status(box.id, org)).application_state).toBe('pending')
    await expect(
      coordinator.replace(box.id, org, { mode: 'enabled', allow_net: [] }, (revision) => revision === 'initial'),
    ).rejects.toMatchObject({ status: 412 })
    expect(persistedOutbound(await store.read(box.id, org))).toEqual(candidate)
    expect(outboundRecord(await store.read(box.id, org)).pending).toBeUndefined()
    expect(writes).toHaveLength(0)
  })

  it('keeps status readable while a writer owns the row and refuses the later stale writer', async () => {
    let release: () => void
    let entered: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const dispatched = new Promise<void>((resolve) => {
      entered = resolve
    })
    onApply = async () => {
      entered()
      await blocked
    }
    const first = coordinator.replace(box.id, org, candidate.policy, (revision) => revision === 'initial')
    await dispatched
    const second = coordinator
      .replace(box.id, org, { mode: 'enabled', allow_net: ['example.com'] }, (revision) => revision === 'initial')
      .then(
        () => ({ status: 200 }),
        (error) => ({ status: error.status }),
      )
    try {
      expect((await coordinator.status(box.id, org)).application_state).toBe('pending')
      const deadline = Date.now() + 2000
      let waiting = false
      while (Date.now() < deadline) {
        const [row] = await primary.query(
          "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND application_name = $1",
          [schema],
        )
        if (row.waiting > 0) {
          waiting = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(waiting).toBe(true)
    } finally {
      release()
    }
    await first
    expect(await second).toEqual({ status: 412 })
    expect(writes).toHaveLength(1)
  })

  it('confirms a lost HTTP acknowledgement only through completed Runtime readback', async () => {
    acknowledge = (_next, response) => response.destroy()
    const result = await coordinator.replace(box.id, org, candidate.policy)
    expect(writes).toHaveLength(1)
    expect(persistedOutbound(result)).toEqual(live)
    expect(outboundRecord(await store.read(box.id, org)).pending).toBeUndefined()
    expect((await coordinator.status(box.id, org)).application_state).toBe('confirmed')
  })

  it.each(['pending', 'uncertain'] as const)(
    'retains durable pending when a matching Runtime revision is still %s after lost ACK',
    async (phase) => {
      runtimePhase = phase
      acknowledge = (_next, response) => response.destroy()
      await expect(coordinator.replace(box.id, org, candidate.policy)).rejects.toThrow()
      expect(writes).toHaveLength(1)
      const durable = await store.read(box.id, org)
      expect(persistedOutbound(durable).revision).toBe('initial')
      expect(outboundRecord(durable).pending?.candidate).toEqual(live)
      expect((await coordinator.status(box.id, org)).application_state).toBe('pending')
      runtimePhase = 'confirmed'
      await expect(
        coordinator.replace(box.id, org, candidate.policy, (revision) => revision === 'initial'),
      ).rejects.toMatchObject({ status: 412 })
      expect(persistedOutbound(await store.read(box.id, org))).toEqual(live)
      expect(writes).toHaveLength(1)
    },
  )

  it('does not clear dispatch intent merely because refusal readback still has the old revision', async () => {
    onApply = async () => {
      throw new Error('controlled peer refused before publication')
    }
    await expect(coordinator.replace(box.id, org, candidate.policy)).rejects.toThrow()
    const durable = await store.read(box.id, org)
    expect(writes).toHaveLength(1)
    expect(persistedOutbound(durable)).toEqual(live)
    expect(outboundRecord(durable).pending?.candidate).toEqual(writes[0].candidate)
    expect((await coordinator.status(box.id, org)).application_state).toBe('pending')
  })

  async function refuseDisabledPublication(operation: () => Promise<void>): Promise<void> {
    // A real PostgreSQL trigger rejects the policy/revision UPDATE after the HTTP ACK.
    await primary.query(`CREATE FUNCTION "${schema}".reject_disabled_publication() RETURNS trigger AS $$
      BEGIN
        IF NEW."outboundControl"->>'revision' IS DISTINCT FROM OLD."outboundControl"->>'revision'
           AND NOT NEW."outboundEnabled" THEN
          RAISE EXCEPTION 'fixture refused disabled publication';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`)
    await primary.query(`CREATE TRIGGER reject_disabled_publication BEFORE UPDATE OF "outboundControl"
      ON "${schema}".box FOR EACH ROW EXECUTE FUNCTION "${schema}".reject_disabled_publication()`)
    try {
      await operation()
    } finally {
      await primary.query(`DROP TRIGGER reject_disabled_publication ON "${schema}".box`)
      await primary.query(`DROP FUNCTION "${schema}".reject_disabled_publication()`)
    }
  }

  it.each(['applied', 'lost'] as const)(
    'handles %s restoration after a managed Cloud publication fails',
    async (outcome) => {
      const registry = new ProxyRegistryStore(primary, new ProxyCredentialCipher(undefined), true)
      const managed = new ManagedOutboundCoordinator(primary, registry)
      const name = `proxy-${randomUUID()}`
      const epoch = 'managed-cloud-restoration'
      await registry.create(org, { name, url: 'https://predecessor.example.com' })
      await store.locked(box.id, org, ({ write }) =>
        write({ version: 1, revision: live.revision, managed: { runnerId, epoch, binding: null } }),
      )
      let snapshot: ManagedReceipt['durable'] = { snapshot: live, binding: null }
      let prepared: Extract<ManagedCommand, { operation: 'prepare' }>['update'] | undefined
      const delivered: string[] = []
      const peer = async (_epoch: string, command: ManagedCommand): Promise<ManagedReceipt> => {
        if (command.operation === 'prepare' || command.operation === 'prepare_restore') {
          if (command.operation === 'prepare_restore') {
            expect(command.failed.candidate).toEqual(snapshot)
            expect(outboundRecord(await store.read(box.id, org)).managed.restoration).toEqual(command.update)
            expect(
              await primary.query(
                'SELECT kind, revision FROM outbound_proxy_reference WHERE box_id = $1 ORDER BY kind',
                [box.id],
              ),
            ).toEqual([
              { kind: 'committed', revision: 1 },
              { kind: 'pending', revision: 1 },
              { kind: 'retained', revision: 2 },
            ])
          }
          prepared = command.update
        }
        if (command.operation === 'apply') {
          expect(prepared.attempt_id).toBe(command.attempt_id)
          delivered.push(command.route.host)
          if (delivered.length === 3 && outcome === 'lost') throw new Error('Controlled restoration loss')
          snapshot = prepared.candidate
          prepared = undefined
        }
        return {
          runner_id: runnerId,
          epoch,
          durable: snapshot,
          installed: snapshot,
          pending_attempt: prepared?.attempt_id ?? null,
          unbind_settlement: null,
          rollback: null,
          retired_attempt: null,
        }
      }
      const protectedControl = async (b: Box) => Object.assign(await control(b), { managed: peer })
      const original = await managed.replace(box.id, org, live.policy, name, protectedControl)
      await registry.update(org, name, { url: 'https://candidate.example.com' })
      await refuseDisabledPublication(async () => {
        await expect(managed.replace(box.id, org, candidate.policy, name, protectedControl)).rejects.toThrow(
          'fixture refused disabled publication',
        )
      })
      expect(delivered).toEqual(['predecessor.example.com', 'candidate.example.com', 'predecessor.example.com'])
      const settled = await store.read(box.id, org)
      if (outcome === 'lost') {
        expect(persistedOutbound(settled)).toEqual(persistedOutbound(original))
        expect(outboundRecord(settled).managed.restoration.candidate.binding.registration_revision).toBe('1')
        await registry.update(org, name, { url: 'https://newer.example.com' })
        await managed.advance(box.id, org, protectedControl)
        expect(delivered).toHaveLength(3)
        expect(
          await primary.query('SELECT kind, revision FROM outbound_proxy_reference WHERE box_id = $1 ORDER BY kind', [
            box.id,
          ]),
        ).toEqual([
          { kind: 'committed', revision: 1 },
          { kind: 'pending', revision: 1 },
          { kind: 'retained', revision: 2 },
        ])
        return
      }
      expect(persistedOutbound(settled)).toEqual(snapshot.snapshot)
      expect(persistedOutbound(settled).revision).not.toBe(persistedOutbound(original).revision)
      expect(outboundRecord(settled).managed.binding.registration_revision).toBe('1')
      expect(
        await primary.query('SELECT kind, revision FROM outbound_proxy_reference WHERE box_id = $1', [box.id]),
      ).toEqual([{ kind: 'committed', revision: 1 }])
    },
  )

  it('reserves a fresh restoration before dispatch after an actual PostgreSQL publication failure', async () => {
    onApply = async (next) => {
      const record = outboundRecord(await new OutboundPolicyStore(primary).read(box.id, org))
      expect(record.pending?.candidate).toEqual(next)
      expect(record.pending?.runnerId).toBe(runnerId)
    }
    await refuseDisabledPublication(async () => {
      await expect(coordinator.replace(box.id, org, candidate.policy)).rejects.toThrow(
        'fixture refused disabled publication',
      )
    })
    expect(writes).toHaveLength(2)
    const [applied, restored] = writes
    expect(restored.expected).toBe(`"${applied.candidate.revision}"`)
    expect(restored.candidate.revision).not.toBe('initial')
    expect(restored.candidate.revision).not.toBe(applied.candidate.revision)
    expect(restored.candidate.policy).toEqual({ mode: 'enabled', allow_net: [] })
    expect(persistedOutbound(await store.read(box.id, org))).toEqual(restored.candidate)
    expect((await coordinator.status(box.id, org)).application_state).toBe('confirmed')
  })

  it('retains the fresh restoration intent when its HTTP application fails', async () => {
    onApply = async () => {
      if (writes.length === 2) throw new Error('controlled peer refused restoration')
    }
    await refuseDisabledPublication(async () => {
      await expect(coordinator.replace(box.id, org, candidate.policy)).rejects.toThrow()
    })
    expect(writes).toHaveLength(2)
    const durable = await store.read(box.id, org)
    expect(persistedOutbound(durable).revision).toBe('initial')
    expect(live).toEqual(writes[0].candidate)
    expect(outboundRecord(durable).pending).toEqual({
      expected: live.revision,
      candidate: writes[1].candidate,
      runnerId,
    })
    expect(writes[1].candidate.revision).not.toBe(live.revision)
    expect((await coordinator.status(box.id, org)).application_state).toBe('pending')
  })

  it('cannot compensate a newer owner after the failed transaction releases its lock', async () => {
    onApply = async () => {
      if (writes.length === 1) proxy.arm('before')
    }
    const locked = store.locked.bind(store)
    let transactions = 0
    const newer: OutboundSnapshot = { revision: 'newer-owner', policy: { mode: 'enabled', allow_net: ['example.com'] } }
    jest.spyOn(store, 'locked').mockImplementation(async (id, organizationId, operation) => {
      if (++transactions === 3) {
        await new OutboundPolicyStore(primary).locked(id, organizationId, ({ write }) =>
          write({ version: 1, revision: newer.revision }, newer),
        )
        live = newer
      }
      return locked(id, organizationId, operation)
    })
    await expect(coordinator.replace(box.id, org, candidate.policy)).rejects.toThrow('lost ownership')
    expect(writes).toHaveLength(1)
    expect(persistedOutbound(await store.read(box.id, org))).toEqual(newer)
  })

  it('does not restore blindly when the database is unavailable after application', async () => {
    onApply = async () => {
      proxy.rejectAfterCut = true
      proxy.arm('before')
    }
    await expect(coordinator.replace(box.id, org, candidate.policy)).rejects.toThrow()
    expect(writes).toHaveLength(1)
    const durable = await new OutboundPolicyStore(primary).read(box.id, org)
    expect(outboundRecord(durable).pending?.candidate).toEqual(live)
    expect(persistedOutbound(durable).revision).toBe('initial')
  }, 15000)
})
