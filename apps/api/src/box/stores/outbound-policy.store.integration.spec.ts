import { createHash, randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { createServer, IncomingHttpHeaders, Server, ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { Box } from '../entities/box.entity'
import { BoxLastActivity } from '../entities/box-last-activity.entity'
import { BoxCheckpointState } from '../entities/box-checkpoint-state.entity'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { AddOutboundControl1794888000000 } from '../../migrations/pre-deploy/1794888000000-add-outbound-control-migration'
import { AddCompleteOutboundControl1795096800000 } from '../../migrations/pre-deploy/1795096800000-add-complete-outbound-control-migration'
import { AddPendingCompleteV0CreateIndex1795096801000 } from '../../migrations/pre-deploy/1795096801000-add-pending-complete-v0-create-index-migration'
import { AddCompleteOutboundAdmission1795096802000 } from '../../migrations/pre-deploy/1795096802000-add-complete-outbound-admission-migration'
import { AddCompleteOutboundAcceptanceWindow1795096809000 } from '../../migrations/pre-deploy/1795096809000-add-complete-outbound-acceptance-window-migration'
import { AddCompleteOutboundEnrollmentAndClaims1795096803000 } from '../../migrations/pre-deploy/1795096803000-add-complete-outbound-enrollment-and-claims-migration'
import { Job } from '../entities/job.entity'
import {
  OutboundCommitUnknown,
  OutboundPolicyStore,
  outboundRecord,
  persistedCompleteOutbound,
  persistedOutbound,
} from './outbound-policy.store'
import { PostgresCommitProxy } from './tests/postgres-commit-proxy'
import { Runner } from '../entities/runner.entity'
import { CompleteOutboundSnapshot, RunnerOutboundControl, OutboundSnapshot } from '../runner-adapter/outbound-control'
import { OutboundPolicyCoordinator } from '../services/outbound-policy.coordinator'
import { CompleteOutboundCoordinator } from '../services/complete-outbound.coordinator'
import { BoxRepository } from '../repositories/box.repository'
import { BoxStartAction } from '../managers/box-actions/box-start.action'
import { BoxManager } from '../managers/box.manager'
import { RunnerAdapterV0 } from '../runner-adapter/runnerAdapter.v0'
import { RunnerState } from '../enums/runner-state.enum'
import { BoxService } from '../services/box.service'
import { Context } from '../../common/context/context'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schema = `outbound_${process.pid}_${randomUUID().replaceAll('-', '')}`
const org = '00000000-0000-4000-8000-0000000000aa'
const runnerId = '00000000-0000-4000-8000-0000000000bb'
const runnerLeaseId = '00000000-0000-4000-8000-0000000000cc'
const candidate = { revision: 'candidate-b', policy: { mode: 'disabled' as const, allow_net: [] } }
const reserved = { version: 1 as const, revision: 'initial', pending: { expected: 'initial', candidate, runnerId } }
const complete: CompleteOutboundSnapshot = {
  revision: 'complete-b',
  admission: 'extended_ipv4',
  policy: { mode: 'enabled', allow_net: [], deny_net: [] },
}

const completeIntent = {
  attemptId: 'attempt-1',
  runnerId,
  runnerLeaseId,
  generation: 1,
  candidate: { snapshot: complete, deny_present: true },
}

describeIfDatabase('durable outbound policy store (real PostgreSQL)', () => {
  let primary: DataSource
  let transport: DataSource
  let proxy: PostgresCommitProxy
  let store: OutboundPolicyStore
  let box: Box
  let ownsSchema = false
  let http: Server
  let live: OutboundSnapshot
  let readCompleteRuntime: (response: ServerResponse) => Promise<void>
  let completeCreatePeer: (
    path: string,
    body: any,
    response: ServerResponse,
    headers: IncomingHttpHeaders,
  ) => Promise<void>
  let runner: Runner
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
      entities: [Box, BoxLastActivity, BoxCheckpointState, Runner, Job],
      synchronize: false,
      entitySkipConstructor: true,
      ssl: false as const,
      extra: { options: `-c search_path=${schema},public`, connectionTimeoutMillis: 3000, query_timeout: 10000 },
    }
    primary = await new DataSource(options).initialize()
    await primary.query(`CREATE SCHEMA "${schema}"`)
    ownsSchema = true
    await primary.synchronize()
    const migration = primary.createQueryRunner()
    try {
      await migration.query('ALTER TABLE "job" DROP "completeOutboundReconciling"')
      await new AddCompleteOutboundEnrollmentAndClaims1795096803000().up(migration)
      await new AddCompleteOutboundAdmission1795096802000().up(migration)
      await new AddCompleteOutboundAcceptanceWindow1795096809000().up(migration)
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
    await primary.query(
      `UPDATE complete_outbound_admission SET phase = 'closed', minimum_release = NULL, api_principal = NULL,
       acceptance_organization_id = NULL, acceptance_expires_at = NULL WHERE id = 1`,
    )
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
    readCompleteRuntime = async (response) => {
      response.writeHead(404).end()
    }
    completeCreatePeer = async (_path, _body, response) => {
      response.writeHead(404).end()
    }
    acknowledge = (next, response) => {
      response.setHeader('ETag', `"${next.revision}"`)
      response.end(JSON.stringify(next.policy))
    }
    http = createServer((request, response) => {
      void (async () => {
        expect(request.headers.authorization).toBe('Bearer synthetic-secret')
        if (request.method === 'GET' && request.url.endsWith('/complete/status')) {
          await readCompleteRuntime(response)
          return
        }
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
        if (request.url.includes('/complete/')) {
          await completeCreatePeer(request.url, JSON.parse(Buffer.concat(chunks).toString()), response, request.headers)
          return
        }
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
    runner = Object.assign(
      new Runner({
        region: 'local',
        name: 'fixture-v0',
        apiUrl: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
        apiKey: 'synthetic-secret',
        apiVersion: '0',
      }),
      {
        id: runnerId,
        state: RunnerState.READY,
      },
    )
    await primary.getRepository(Runner).save(runner)
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

  async function enrollV0(release: string) {
    const hash = createHash('sha256').update(runner.apiKey).digest('hex')
    await primary.query(
      `INSERT INTO complete_outbound_runner_enrollment
      (runner_id, lease_id, token_sha256, runner_key_sha256, verified_floor, expires_at)
      VALUES ($1, $2, $3, $3, $4, clock_timestamp() + interval '1 hour')
      ON CONFLICT (runner_id) DO UPDATE SET verified_floor = EXCLUDED.verified_floor, expires_at = EXCLUDED.expires_at`,
      [runner.id, runnerLeaseId, hash, release],
    )
  }

  it('isolates complete policy update reservations to the release acceptance organization', async () => {
    await primary.query(
      `UPDATE complete_outbound_admission SET phase = 'open', minimum_release = 'test-release',
       api_principal = current_user, deployment_receipt = 'fixture', acceptance_organization_id = $1,
       acceptance_expires_at = clock_timestamp() + interval '1 hour'`,
      [randomUUID()],
    )
    const reserveUpdate = jest.fn(async () => undefined)
    await expect(store.lockedComplete(box.id, org, true, reserveUpdate)).rejects.toMatchObject({ status: 503 })
    expect(reserveUpdate).not.toHaveBeenCalled()

    await primary.query('UPDATE complete_outbound_admission SET acceptance_organization_id = $1', [org])
    await expect(store.lockedComplete(box.id, org, true, reserveUpdate)).resolves.toBeUndefined()
    expect(reserveUpdate).toHaveBeenCalledTimes(1)
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

  it('expands complete storage and refuses downgrade with a protected empty policy', async () => {
    const runner = primary.createQueryRunner()
    const migration = new AddCompleteOutboundControl1795096800000()
    try {
      await runner.startTransaction()
      await migration.down(runner)
      await migration.up(runner)
      await runner.commitTransaction()
      const restarted = new OutboundPolicyStore(primary)
      expect(persistedCompleteOutbound(await restarted.read(box.id, org))).toEqual({
        revision: 'initial',
        admission: 'legacy',
        policy: { mode: 'enabled', allow_net: [], deny_net: [] },
      })
      await primary.getRepository(Box).update(box.id, { completeOutboundControl: { version: 2, committed: complete } })

      await runner.startTransaction()
      await expect(migration.down(runner)).rejects.toThrow('Complete outbound policy or pending work blocks downgrade')
      await runner.rollbackTransaction()
      expect(persistedCompleteOutbound(await restarted.read(box.id, org))).toEqual(complete)
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction()
      await runner.release()
    }
  })

  it('builds and retires the live V0 pagination index outside the migration transaction', async () => {
    const runner = primary.createQueryRunner()
    const index = new AddPendingCompleteV0CreateIndex1795096801000()
    try {
      await index.up(runner)
      await index.up(runner)
      const [present] = await runner.query(
        "SELECT to_regclass('idx_box_pending_complete_v0_create') IS NOT NULL AS found",
      )
      expect(present.found).toBe(true)
      await index.down(runner)
      const [removed] = await runner.query("SELECT to_regclass('idx_box_pending_complete_v0_create') IS NULL AS gone")
      expect(removed.gone).toBe(true)
    } finally {
      await runner.release()
    }
  })

  it('returns only the committed complete snapshot during promotion and blocks the legacy update', async () => {
    const predecessor: CompleteOutboundSnapshot = {
      revision: 'legacy-a',
      admission: 'legacy',
      policy: { mode: 'enabled', allow_net: ['example.com'], deny_net: [] },
    }
    await primary.getRepository(Box).update(box.id, {
      completeOutboundControl: {
        version: 2,
        committed: predecessor,
        pending: { ...completeIntent, kind: 'replace', incarnation: box.id, previousProtected: false },
      },
    })
    const persistedBox = await store.read(box.id, org)
    expect(persistedCompleteOutbound(persistedBox)).toEqual(predecessor)
    await expect(store.read(box.id, randomUUID())).rejects.toThrow('Box not found')
    expect(() => persistedOutbound(persistedBox)).toThrow('Box requires complete outbound control')
    await expect(coordinator.replace(box.id, org, candidate.policy)).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'complete_policy_required' }),
    })
    expect(writes).toHaveLength(0)
    expect(persistedCompleteOutbound(await store.read(box.id, org))).toEqual(predecessor)
  })

  it('does not read a pending first create as an installed complete policy', async () => {
    await primary.getRepository(Box).update(box.id, {
      completeOutboundControl: {
        version: 2,
        committed: null,
        pending: { ...completeIntent, kind: 'create', transport: 'v0', incarnation: box.id },
      },
    })
    const pending = await store.read(box.id, org)
    expect(persistedCompleteOutbound(pending)).toBeNull()
    expect(() => persistedOutbound(pending)).toThrow('Box requires complete outbound control')
    const repository = new BoxRepository(primary, { emit: jest.fn() } as never, {} as never)
    const observe = jest.fn()
    await expect(repository.completeOutboundStatus(box.id, org, observe)).resolves.toEqual({
      persisted: null,
      runtime_persisted: null,
      observed: null,
      application_state: 'pending',
      pending_revision: complete.revision,
    })
    expect(observe).not.toHaveBeenCalled()
  })

  async function reserveV0Create(createdAt = new Date(Date.now() - 60_000)) {
    await enrollV0('test-release')
    await primary.query(
      "UPDATE complete_outbound_admission SET minimum_release = 'test-release', api_principal = current_user WHERE id = 1",
    )
    const pending = { ...completeIntent, kind: 'create', transport: 'v0', incarnation: box.id } as const
    const reservation = { version: 2, committed: null, pending } as const
    await primary.getRepository(Box).update(box.id, {
      state: BoxState.UNKNOWN,
      pending: true,
      createdAt,
      image: 'base',
      outboundAllowNet: ['legacy-shadow.example'],
      volumes: [{ volumeId: 'volume-a', mountPath: '/workspace' }],
      completeOutboundControl: reservation,
    })
    return reservation
  }

  async function v0Manager() {
    const emit = jest.fn()
    const repository = new BoxRepository(
      primary,
      { emit } as never,
      {
        invalidate: jest.fn(),
        invalidateOrgId: jest.fn(),
      } as never,
    )
    const runnerService = { findOne: async () => runner }
    const adapter = new RunnerAdapterV0()
    await adapter.init(runner)
    const action = new BoxStartAction(
      runnerService as never,
      { create: async () => adapter } as never,
      repository,
      { findOne: async () => ({}), isNestedVirtualizationEnabled: async () => false } as never,
      { getOrThrow: () => 1 } as never,
      {} as never,
      {} as never,
      { refFor: async (_runner: string, image: string) => image } as never,
    )
    const manager = new BoxManager(
      repository,
      runnerService as never,
      {} as never,
      { lock: async () => true, unlock: async () => undefined } as never,
      action,
      {} as never,
      {} as never,
      {} as never,
    )
    return { manager, emit, repository }
  }

  it('admits from BoxService only after an exact preparation and holds the release lock through insert', async () => {
    const { manager, repository } = await v0Manager()
    const events: Promise<void>[] = []
    const trace: string[] = []
    const open =
      "UPDATE complete_outbound_admission SET phase = 'open', minimum_release = 'test-release', api_principal = current_user, deployment_receipt = 'fixture' WHERE id = 1"
    const close = "UPDATE complete_outbound_admission SET phase = 'closed', minimum_release = NULL WHERE id = 1"
    const service = Object.assign(Object.create(BoxService.prototype), {
      boxRepository: repository,
      organizationService: {
        isNestedVirtualizationEnabled: async () => false,
        assertOrganizationIsNotSuspended: () => undefined,
      },
      getValidatedOrDefaultRegion: async () => ({ id: 'local' }),
      runnerService: { getRandomAvailableRunner: async () => runner },
      organizationBoxLimits: { resolve: async () => ({}) },
      imageAdmissionService: {
        assert: async () => undefined,
        spendColdPullBudget: async () => trace.push('budget'),
      },
      imageResolverService: { resolve: async () => ({ ref: 'base', isOrgOwned: false }) },
      eventEmitter: {
        emitAsync: (_event: string, payload: { box: Box }) => {
          const work = manager.syncInstanceState(payload.box.id, undefined, 'dispatch')
          events.push(work)
          return work
        },
      },
      toBoxDto: async (row: Box) => ({ id: row.id, state: row.state }),
    }) as BoxService
    const create = () =>
      service.create({ name: 'admitted-v0', image: 'base' }, { id: org } as never, Context.user(), {
        completeOutbound: { mode: 'enabled', allow_net: [], deny_net: [] },
        onPersist: async () => {
          // Release close takes an exclusive row lock. A second connection
          // cannot acquire it while the transaction that reserved the Box commits.
          await expect(
            primary.query('SELECT id FROM complete_outbound_admission FOR UPDATE NOWAIT'),
          ).rejects.toMatchObject({ code: '55P03' })
          trace.push('reserved')
        },
      })
    try {
      await expect(create()).rejects.toMatchObject({
        status: 503,
        response: expect.objectContaining({ code: 'complete_outbound_closed' }),
      })
      expect(trace).toEqual([])
      await primary.query(open)
      await enrollV0('test-release')
      completeCreatePeer = async (path, _body, response) => {
        trace.push(path.split('/').at(-1))
        response.writeHead(501).end(JSON.stringify({ error: { code: 'unsupported' } }))
      }
      await expect(create()).rejects.toMatchObject({ status: 501 })
      expect(trace).toEqual(['prepare-create'])
      expect(await primary.getRepository(Box).findOneBy({ organizationId: org, name: 'admitted-v0' })).toBeNull()
      expect(events).toHaveLength(0)

      let closing: Promise<unknown> | undefined
      const reserve = repository.insertCompleteCreate.bind(repository)
      jest.spyOn(repository, 'insertCompleteCreate').mockImplementationOnce(async (...args) => {
        expect(closing).toBeDefined()
        await closing
        return reserve(...args)
      })
      completeCreatePeer = async (_path, _body, response, headers) => {
        trace.push('prepared-while-closing')
        await expect(
          primary.query('SELECT id FROM complete_outbound_admission FOR UPDATE NOWAIT'),
        ).rejects.toMatchObject({ code: '55P03' })
        closing = primary.query(close)
        response.end(
          JSON.stringify({
            snapshot: { ...complete, revision: headers['x-boxlite-outbound-revision'] },
            deny_present: true,
          }),
        )
      }
      await expect(create()).rejects.toMatchObject({
        status: 503,
        response: expect.objectContaining({ code: 'complete_outbound_closed' }),
      })
      expect(trace).toEqual(['prepare-create', 'prepared-while-closing'])
      expect(await primary.getRepository(Box).findOneBy({ organizationId: org, name: 'admitted-v0' })).toBeNull()
      await primary.query(open)

      completeCreatePeer = async (path, body, response, headers) => {
        trace.push(path.split('/').at(-1))
        if (path.endsWith('/prepare-create')) {
          expect(body).toEqual({ mode: 'enabled', allow_net: [], deny_net: [] })
          response.end(
            JSON.stringify({
              snapshot: { ...complete, revision: headers['x-boxlite-outbound-revision'] },
              deny_present: true,
            }),
          )
          return
        }
        const committed = await store.read(body.box.id, org)
        expect(committed.completeOutboundControl?.pending?.candidate).toEqual(body.attempt.prepared)
        response.end(
          JSON.stringify({ attempt: body.attempt, outcome: 'installed', snapshot: body.attempt.prepared.snapshot }),
        )
      }
      const created = await create()
      await Promise.all(events)
      expect(trace).toEqual([
        'prepare-create',
        'prepared-while-closing',
        'prepare-create',
        'budget',
        'reserved',
        'create',
      ])
      expect(await store.read(created.id, org)).toMatchObject({ state: BoxState.STARTED, pending: false })
    } finally {
      await Promise.allSettled(events)
      await primary.getRepository(Box).delete({ organizationId: org, name: 'admitted-v0' })
      await primary.query(close)
    }
  })

  it('dispatches a committed V0 create through the complete route and publishes its exact installation once', async () => {
    const reservation = await reserveV0Create(new Date())
    const { manager, emit } = await v0Manager()
    const routes: string[] = []
    completeCreatePeer = async (path, body, response) => {
      routes.push(path)
      expect((await store.read(box.id, org)).completeOutboundControl).toEqual(reservation)
      expect(body.box).toMatchObject({ id: box.id, volumes: [{ volumeId: 'volume-a', mountPath: '/workspace' }] })
      expect(body.box).not.toHaveProperty('outboundEnabled')
      expect(body.box).not.toHaveProperty('outboundAllowNet')
      response.end(JSON.stringify({ attempt: body.attempt, outcome: 'installed', snapshot: complete }))
    }
    await manager.reconcileV0Creates()
    expect(routes).toEqual([])
    await manager.syncInstanceState(box.id, undefined, 'dispatch')
    await manager.syncInstanceState(box.id, undefined, 'dispatch')
    expect(routes).toEqual([`/v1/boxes/${box.id}/network/outbound/complete/create`])
    expect(await store.read(box.id, org)).toMatchObject({
      state: BoxState.STARTED,
      pending: false,
      completeOutboundControl: { version: 2, committed: complete },
    })
    expect(emit.mock.calls.filter(([type]) => type === 'box.state.updated')).toHaveLength(1)
  })

  it('keeps a V0 reservation pending when the enrolled Runner identity has changed', async () => {
    const reservation = await reserveV0Create()
    const { manager } = await v0Manager()
    const peer = jest.fn()
    completeCreatePeer = peer
    try {
      await primary.getRepository(Runner).update(runner.id, { apiKey: 'unenrolled-credential' })
      await manager.syncInstanceState(box.id, undefined, 'dispatch')
      await manager.reconcileV0Creates()
      expect(peer).not.toHaveBeenCalled()
      expect(await store.read(box.id, org)).toMatchObject({ pending: true, completeOutboundControl: reservation })
    } finally {
      await primary.getRepository(Box).delete(box.id)
    }
  })

  it('uses cancellation to recover an aged V0 intent and ignores a receipt from a superseded runner', async () => {
    const reservation = await reserveV0Create()
    const { manager } = await v0Manager()
    const routes: string[] = []
    const changeRunner = async () => primary.getRepository(Box).update(box.id, { runnerId: randomUUID() })
    completeCreatePeer = async (path, attempt, response) => {
      routes.push(path)
      await changeRunner()
      response.end(JSON.stringify({ attempt, outcome: 'no_effect', failure: 'unsupported' }))
    }
    await manager.reconcileV0Creates()
    expect(await store.read(box.id, org)).toMatchObject({ pending: true, completeOutboundControl: reservation })
    await primary.getRepository(Box).update(box.id, { runnerId })
    completeCreatePeer = async (path, attempt, response) => {
      routes.push(path)
      response.end(JSON.stringify({ attempt, outcome: 'no_effect', failure: 'unsupported' }))
    }
    await manager.reconcileV0Creates()
    expect(routes).toEqual(Array(2).fill(`/v1/boxes/${box.id}/network/outbound/complete/cancel-create`))
    expect(await store.read(box.id, org)).toMatchObject({
      state: BoxState.ERROR,
      pending: false,
      runnerId: null,
      errorReason: 'outbound_create_unsupported',
      completeOutboundControl: null,
    })
  })

  it.each(['lost reply', 'execution refusal'] as const)(
    'settles %s through the bound Runner receipt without retrying creation',
    async (scenario) => {
      const reservation = await reserveV0Create()
      const { manager } = await v0Manager()
      const routes: string[] = []
      completeCreatePeer = async (path, body, response) => {
        routes.push(path.split('/').at(-1))
        if (path.endsWith('/create')) {
          if (scenario === 'lost reply') {
            response.destroy()
          } else {
            response.writeHead(501).end(JSON.stringify({ error: { code: 'unsupported' } }))
          }
          return
        }
        const evidence =
          scenario === 'lost reply'
            ? { outcome: 'installed', snapshot: reservation.pending.candidate.snapshot }
            : { outcome: 'no_effect', failure: 'unsupported' }
        response.end(JSON.stringify({ attempt: body, ...evidence }))
      }
      await manager.syncInstanceState(box.id, undefined, 'dispatch')
      if (scenario === 'lost reply') {
        expect(await store.read(box.id, org)).toMatchObject({ pending: true, completeOutboundControl: reservation })
        await manager.reconcileV0Creates()
        expect(await store.read(box.id, org)).toMatchObject({
          state: BoxState.STARTED,
          pending: false,
          completeOutboundControl: { version: 2, committed: complete },
        })
      } else {
        expect(await store.read(box.id, org)).toMatchObject({
          state: BoxState.ERROR,
          pending: false,
          completeOutboundControl: null,
          errorReason: 'outbound_create_unsupported',
        })
      }
      await manager.reconcileV0Creates()
      expect(routes).toEqual(['create', 'cancel-create'])
    },
  )

  it('confirms only exact Cloud, durable Runtime, and live Runtime agreement', async () => {
    const repository = new BoxRepository(primary, { emit: jest.fn() } as never, {} as never)
    const readStatus = () =>
      repository.completeOutboundStatus(box.id, org, async (row) => (await control(row)).completeStatus())
    await primary.getRepository(Box).update(box.id, { completeOutboundControl: { version: 2, committed: complete } })
    const respondWith = (response: ServerResponse, installed: CompleteOutboundSnapshot) =>
      response.end(
        JSON.stringify({
          persisted: installed,
          observed: { snapshot: installed, application_state: 'confirmed' },
          application_state: 'confirmed',
        }),
      )

    await expect(readStatus()).resolves.toMatchObject({
      persisted: complete,
      runtime_persisted: null,
      observed: null,
      application_state: 'uncertain',
    })
    const different = { ...complete, policy: { ...complete.policy, deny_net: ['example.com'] } }
    readCompleteRuntime = async (response) => {
      respondWith(response, different)
    }
    await expect(readStatus()).resolves.toMatchObject({
      persisted: complete,
      runtime_persisted: different,
      application_state: 'uncertain',
    })
    readCompleteRuntime = async (response) => {
      respondWith(response, complete)
    }
    await expect(readStatus()).resolves.toMatchObject({
      persisted: complete,
      runtime_persisted: complete,
      observed: { snapshot: complete },
      application_state: 'confirmed',
    })
  })

  it('discards a late Runner confirmation when a Cloud replacement starts during the read', async () => {
    const repository = new BoxRepository(primary, { emit: jest.fn() } as never, {} as never)
    const predecessor = { ...complete, revision: 'complete-a' }
    await primary.getRepository(Box).update(box.id, { completeOutboundControl: { version: 2, committed: predecessor } })
    readCompleteRuntime = async (response) => {
      await primary.getRepository(Box).update(box.id, {
        completeOutboundControl: {
          version: 2,
          committed: predecessor,
          pending: { ...completeIntent, kind: 'replace', incarnation: box.id, previousProtected: true },
        },
      })
      response.end(
        JSON.stringify({
          persisted: predecessor,
          observed: { snapshot: predecessor, application_state: 'confirmed' },
          application_state: 'confirmed',
        }),
      )
    }
    await expect(
      repository.completeOutboundStatus(box.id, org, async (row) => (await control(row)).completeStatus()),
    ).resolves.toEqual({
      persisted: predecessor,
      runtime_persisted: null,
      observed: null,
      application_state: 'pending',
      pending_revision: complete.revision,
    })
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

  it.each([
    { fault: 'before', available: true },
    { fault: 'after', available: true },
    { fault: 'after', available: false },
  ] as const)(
    'handles a lost $fault-COMMIT reply with primary availability $available',
    async ({ fault, available }) => {
      const coordinator = new CompleteOutboundCoordinator(store)
      const requests: string[] = []
      const predecessor = persistedCompleteOutbound(await store.read(box.id, org))!
      let installed = predecessor
      try {
        await primary.query(
          "UPDATE complete_outbound_admission SET phase = 'open', minimum_release = 'fixture', api_principal = current_user, deployment_receipt = 'fixture' WHERE id = 1",
        )
        await enrollV0('fixture')
        completeCreatePeer = async (path, command, response) => {
          expect(path).toBe(`/v1/boxes/${box.id}/network/outbound/complete/replace-control`)
          requests.push(command.operation)
          const current = await new OutboundPolicyStore(primary).read(box.id, org)
          const pending = current.completeOutboundControl?.pending
          switch (command.operation) {
            case 'prepare':
              expect(command.previous).toEqual(predecessor)
              expect(current.completeOutboundControl).toBeNull()
              response.end(
                JSON.stringify({
                  outcome: 'prepared',
                  candidate: { snapshot: { ...complete, revision: command.revision }, deny_present: true },
                }),
              )
              break
            case 'apply':
              expect(pending).toMatchObject({
                kind: 'replace',
                incarnation: command.attempt.incarnation,
                attemptId: command.attempt.attempt_id,
                generation: command.attempt.generation,
                candidate: command.attempt.candidate,
              })
              installed = command.attempt.candidate.snapshot
              proxy.rejectAfterCut = !available
              proxy.arm(fault)
              response.end(JSON.stringify({ outcome: 'applied', snapshot: installed }))
              break
            case 'cancel':
              response.end(JSON.stringify({ outcome: 'applied', snapshot: installed }))
              break
            case 'restore':
              expect(pending).toMatchObject({ restorationRevision: command.revision })
              expect(command.revision).not.toBe(predecessor.revision)
              installed = { ...predecessor, revision: command.revision }
              response.end(JSON.stringify({ outcome: 'restored', snapshot: installed }))
              break
            case 'finalize':
              expect(current.completeOutboundControl?.finalization?.attempt).toEqual(command.attempt)
              expect(persistedCompleteOutbound(current)).toEqual(installed)
              response.end(JSON.stringify({ outcome: 'finalized', snapshot: installed }))
              break
            default:
              response.writeHead(500).end()
          }
        }
        await expect(coordinator.replace(box.id, org, complete.policy, () => false)).rejects.toMatchObject({
          status: 412,
        })
        expect(requests).toEqual([])
        const result = coordinator.replace(box.id, org, complete.policy)
        if (!available) {
          await expect(result).rejects.toMatchObject({ status: 503 })
          expect(requests).toEqual(['prepare', 'apply'])
          const durable = await new OutboundPolicyStore(primary).read(box.id, org)
          expect(persistedCompleteOutbound(durable)).toEqual(installed)
          expect(durable.completeOutboundControl?.pending).toBeUndefined()
          expect(durable.completeOutboundControl?.finalization).toBeDefined()
          return
        }
        if (fault === 'before') {
          await expect(result).rejects.toMatchObject({ status: 503 })
          expect(requests).toEqual(['prepare', 'apply', 'cancel', 'restore', 'finalize'])
        } else {
          await expect(result).resolves.toMatchObject({ admission: 'extended_ipv4', policy: complete.policy })
          expect(requests).toEqual(['prepare', 'apply', 'finalize'])
        }
        const resolved = await store.read(box.id, org)
        expect(persistedCompleteOutbound(resolved)).toEqual(installed)
        expect(resolved.completeOutboundGeneration).toBe(1)
        expect(resolved.completeOutboundControl?.pending).toBeUndefined()
        expect(resolved.completeOutboundControl?.finalization).toBeUndefined()
        if (fault === 'before') expect(resolved.completeOutboundControl).toBeNull()
        const completedRequests = [...requests]
        await expect(
          coordinator.replace(box.id, org, complete.policy, (revision) => revision === predecessor.revision),
        ).rejects.toMatchObject({ status: 412 })
        expect(requests).toEqual(completedRequests)
      } finally {
        await primary.query("UPDATE complete_outbound_admission SET phase = 'closed' WHERE id = 1")
      }
    },
  )

  it.each(['before', 'after'] as const)(
    'preserves a successor that takes ownership %s primary readback',
    async (timing) => {
      const ownedCoordinator = new CompleteOutboundCoordinator(store)
      const primaryStore = new OutboundPolicyStore(primary)
      const predecessor = persistedCompleteOutbound(await primaryStore.read(box.id, org))!
      const requests: string[] = []
      const successorId = randomUUID()
      const successorSnapshot = { ...complete, revision: randomUUID() }
      await primary.query(
        "UPDATE complete_outbound_admission SET phase = 'open', minimum_release = 'fixture', api_principal = current_user, deployment_receipt = 'fixture' WHERE id = 1",
      )
      try {
        await enrollV0('fixture')
        completeCreatePeer = async (path, command, response) => {
          expect(path).toBe(`/v1/boxes/${box.id}/network/outbound/complete/replace-control`)
          requests.push(command.operation)
          if (command.operation === 'prepare') {
            expect(command.previous).toEqual(predecessor)
            response.end(
              JSON.stringify({
                outcome: 'prepared',
                candidate: { snapshot: { ...complete, revision: command.revision }, deny_present: true },
              }),
            )
          } else if (command.operation === 'apply') {
            response.destroy()
          } else {
            response.writeHead(500).end()
          }
        }

        const read = store.read.bind(store)
        jest.spyOn(store, 'read').mockImplementationOnce(async (id, organizationId) => {
          const observed = timing === 'after' ? await read(id, organizationId) : undefined
          await primaryStore.lockedComplete(id, organizationId, false, async ({ box: current, write }) => {
            const previousOwner = current.completeOutboundControl?.pending
            if (previousOwner?.kind !== 'replace') throw new Error('Expected the interrupted attempt')
            if (observed) expect(observed.completeOutboundControl?.pending).toEqual(previousOwner)
            const successor = {
              ...previousOwner,
              attemptId: successorId,
              generation: previousOwner.generation + 1,
              candidate: { snapshot: successorSnapshot, deny_present: true },
            }
            await write({ version: 2, committed: predecessor, pending: successor }, successor.generation)
          })
          return observed ?? read(id, organizationId)
        })

        await expect(ownedCoordinator.replace(box.id, org, complete.policy)).rejects.toMatchObject({ status: 503 })
        expect(requests).toEqual(['prepare', 'apply'])
        const durable = await primaryStore.read(box.id, org)
        expect(durable.completeOutboundGeneration).toBe(2)
        expect(durable.completeOutboundControl).toMatchObject({
          committed: predecessor,
          pending: { attemptId: successorId, candidate: { snapshot: successorSnapshot } },
        })
        expect(durable.completeOutboundControl?.pending).not.toHaveProperty('restorationRevision')
        await expect(ownedCoordinator.replace(box.id, org, complete.policy)).rejects.toMatchObject({ status: 409 })
        expect(requests).toEqual(['prepare', 'apply'])
      } finally {
        await primary.query("UPDATE complete_outbound_admission SET phase = 'closed' WHERE id = 1")
      }
    },
  )

  it.each(['cancelled', 'lost', 'wrong admission', 'restored', 'restore lost'] as const)(
    'preserves the durable state for an owned apply with a %s outcome',
    async (outcome) => {
      const ownedCoordinator = new CompleteOutboundCoordinator(store)
      const old = persistedCompleteOutbound(await store.read(box.id, org))!
      const requests: string[] = []
      const shouldRestore = outcome === 'restored' || outcome === 'restore lost'
      let proposed: CompleteOutboundSnapshot | undefined
      let restored: CompleteOutboundSnapshot | undefined
      await primary.query(
        "UPDATE complete_outbound_admission SET phase = 'open', minimum_release = 'fixture', api_principal = current_user, deployment_receipt = 'fixture' WHERE id = 1",
      )
      try {
        await enrollV0('fixture')
        completeCreatePeer = async (_path, command, response) => {
          requests.push(command.operation)
          if (command.operation === 'prepare') {
            proposed = { ...complete, revision: command.revision }
            response.end(JSON.stringify({ outcome: 'prepared', candidate: { snapshot: proposed, deny_present: true } }))
          } else if (command.operation === 'apply' && (outcome === 'lost' || shouldRestore)) {
            response.destroy()
          } else if (outcome === 'cancelled' && ['apply', 'cancel'].includes(command.operation)) {
            response.end(JSON.stringify({ outcome: 'cancelled' }))
          } else if (outcome === 'wrong admission' && ['apply', 'reconcile'].includes(command.operation)) {
            response.end(JSON.stringify({ outcome: 'applied', snapshot: { ...proposed, admission: 'legacy' } }))
          } else if (shouldRestore && command.operation === 'reconcile') {
            response.end(JSON.stringify({ outcome: 'applied', snapshot: proposed }))
          } else if (shouldRestore && command.operation === 'restore') {
            expect(command.revision).not.toBe(proposed?.revision)
            expect(command.revision).not.toBe(old.revision)
            const current = await new OutboundPolicyStore(primary).read(box.id, org)
            expect(current.completeOutboundControl?.pending).toMatchObject({
              restorationRevision: command.revision,
            })
            restored = { ...old, revision: command.revision }
            if (outcome === 'restore lost') response.destroy()
            else response.end(JSON.stringify({ outcome: 'restored', snapshot: restored }))
          } else if (outcome === 'restored' && command.operation === 'finalize') {
            response.end(JSON.stringify({ outcome: 'finalized', snapshot: restored }))
          } else if (['cancel', 'reconcile'].includes(command.operation)) {
            response.end(JSON.stringify({ outcome: 'pending' }))
          } else {
            response.writeHead(500).end()
          }
        }

        await expect(ownedCoordinator.replace(box.id, org, complete.policy)).rejects.toMatchObject({
          status: outcome === 'cancelled' ? 409 : 503,
        })
        const durable = await store.read(box.id, org)
        expect(persistedCompleteOutbound(durable)).toEqual(outcome === 'restored' ? restored : old)
        if (outcome === 'cancelled') {
          expect(requests).toEqual(['prepare', 'apply', 'cancel'])
          expect(durable.completeOutboundControl).toBeNull()
        } else if (outcome === 'restored') {
          expect(requests).toEqual(['prepare', 'apply', 'cancel', 'reconcile', 'restore', 'finalize'])
          expect(durable.completeOutboundControl?.pending).toBeUndefined()
        } else if (outcome === 'restore lost') {
          expect(requests).toEqual(['prepare', 'apply', 'cancel', 'reconcile', 'restore'])
          expect(durable.completeOutboundControl?.pending).toMatchObject({
            candidate: { snapshot: proposed },
            restorationRevision: restored?.revision,
          })
        } else {
          expect(requests).toEqual(['prepare', 'apply', 'cancel', 'reconcile'])
          expect(durable.completeOutboundControl?.pending).toMatchObject({ candidate: { snapshot: proposed } })
        }
      } finally {
        await primary.query("UPDATE complete_outbound_admission SET phase = 'closed' WHERE id = 1")
      }
    },
  )

  it('keeps the hosted deny on omission and publishes an explicit empty deny after apply', async () => {
    const ownedCoordinator = new CompleteOutboundCoordinator(store)
    const predecessor = {
      ...complete,
      revision: 'active-deny',
      policy: { ...complete.policy, deny_net: ['192.0.2.0/24:443'] },
    }
    const requests: string[] = []
    await primary.query(
      "UPDATE complete_outbound_admission SET phase = 'open', minimum_release = 'fixture', api_principal = current_user, deployment_receipt = 'fixture' WHERE id = 1",
    )
    try {
      await enrollV0('fixture')
      await primary.getRepository(Box).update(box.id, {
        completeOutboundControl: { version: 2, committed: predecessor },
      })
      completeCreatePeer = async (_path, command, response) => {
        requests.push(command.operation)
        switch (command.operation) {
          case 'prepare':
            expect(command.previous).toEqual(predecessor)
            if (!Object.hasOwn(command.policy, 'deny_net')) {
              response.writeHead(400).end(JSON.stringify({ error: { code: 'invalid_argument' } }))
              break
            }
            expect(command.policy.deny_net).toEqual([])
            response.end(
              JSON.stringify({
                outcome: 'prepared',
                candidate: { snapshot: { ...complete, revision: command.revision }, deny_present: true },
              }),
            )
            break
          case 'apply':
            expect(command.attempt.candidate.deny_present).toBe(true)
            response.end(JSON.stringify({ outcome: 'applied', snapshot: command.attempt.candidate.snapshot }))
            break
          case 'finalize':
            response.end(JSON.stringify({ outcome: 'finalized', snapshot: command.attempt.candidate.snapshot }))
            break
          default:
            response.writeHead(500).end()
        }
      }
      await expect(ownedCoordinator.replace(box.id, org, { mode: 'enabled', allow_net: [] })).rejects.toMatchObject({
        status: 400,
        response: expect.objectContaining({ code: 'invalid_argument' }),
      })
      expect(requests).toEqual(['prepare'])
      expect(persistedCompleteOutbound(await store.read(box.id, org))).toEqual(predecessor)
      const cleared = await ownedCoordinator.replace(box.id, org, complete.policy)
      expect(requests).toEqual(['prepare', 'prepare', 'apply', 'finalize'])
      expect(cleared.revision).not.toBe(predecessor.revision)
      expect(cleared.admission).toBe('extended_ipv4')
      expect(cleared.policy.deny_net).toEqual([])
      const durable = await store.read(box.id, org)
      expect(persistedCompleteOutbound(durable)).toEqual(cleared)
      expect(durable.completeOutboundControl?.pending).toBeUndefined()
    } finally {
      await primary.query("UPDATE complete_outbound_admission SET phase = 'closed' WHERE id = 1")
    }
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
