import { randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { Agent } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Test } from '@nestjs/testing'
import axios from 'axios'
import { DataSource } from 'typeorm'
import { createServer, Server, ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { Box } from '../entities/box.entity'
import { BoxLastActivity } from '../entities/box-last-activity.entity'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxConflictError } from '../errors/box-conflict.error'
import { ApiKeyStrategy } from '../../auth/api-key.strategy'
import { AddOutboundControl1794888000000 } from '../../migrations/pre-deploy/1794888000000-add-outbound-control-migration'
import { OutboundCommitUnknown, OutboundPolicyStore, outboundRecord, persistedOutbound } from './outbound-policy.store'
import { PostgresCommitProxy } from './tests/postgres-commit-proxy'
import { Runner } from '../entities/runner.entity'
import { RunnerOutboundControl, OutboundSnapshot } from '../runner-adapter/outbound-control'
import { OutboundPolicyCoordinator } from '../services/outbound-policy.coordinator'
import { BoxRepository } from '../repositories/box.repository'
import { ProtectedBootstrapService } from '../services/protected-bootstrap.service'
import { ProtectedBootstrapController } from '../controllers/protected-bootstrap.controller'
import { RunnerAdapterV0 } from '../runner-adapter/runnerAdapter.v0'
import type { ProtectedBootKey } from '../runner-adapter/protected-runner'

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

  it('fences ordinary startup and requires exact reclaim evidence after a lost confirmation', async () => {
    const token = randomUUID()
    const runner = await primary.getRepository(Runner).save(
      new Runner({
        name: token,
        apiKey: token,
        apiVersion: '0',
        region: org,
        apiUrl: 'https://runner.example.test',
        proxyUrl: 'https://proxy.example.test',
      }),
    )
    await primary.getRepository(Box).update(box.id, { state: BoxState.STARTING, runnerId: runner.id, pending: true })
    const key: ProtectedBootKey = {
      runner_id: runner.id,
      attempt_id: randomUUID(),
      registration_id: randomUUID(),
      registration_revision: '1',
      policy: persistedOutbound(await store.read(box.id, org)),
    }
    const emit = jest.fn()
    const repository = new BoxRepository(primary, { emit } as never, { invalidate: jest.fn() } as never)
    const bootstrap = new ProtectedBootstrapService(transport, repository)
    const fingerprint = 'f'.repeat(64)
    const command = { box_id: box.id, key, fingerprint, native_id: 'exact-native-box' }
    const authorization = `Bearer ${token}`
    const cuts = proxy.cuts
    proxy.arm('after')
    await expect(bootstrap.reserve(box, key, fingerprint, fingerprint)).rejects.toBeInstanceOf(OutboundCommitUnknown)
    expect(proxy.cuts).toBe(cuts + 1)
    await bootstrap.reserve(box, key, fingerprint, fingerprint)
    await expect(store.locked(box.id, org, ({ write }) => write(reserved))).rejects.toThrow('fenced')
    await expect(
      bootstrap.authorize(runner.id, authorization, { ...command, box_id: 'missingbox12', operation: 'prepare' }),
    ).rejects.toThrow()
    await expect(bootstrap.authorize(runnerId, authorization, { ...command, operation: 'prepare' })).rejects.toThrow(
      'unavailable or ambiguous',
    )
    await expect(
      bootstrap.authorize(runner.id, authorization, {
        ...command,
        key: { ...key, attempt_id: randomUUID() },
        operation: 'prepare',
      }),
    ).rejects.toThrow('owner differs')
    await expect(
      bootstrap.authorize(runner.id, authorization, { ...command, fingerprint: '0'.repeat(64), operation: 'prepare' }),
    ).rejects.toThrow('does not match its reservation')
    await bootstrap.authorize(runner.id, authorization, { ...command, operation: 'prepare' })
    await bootstrap.prepared(box.id, key, command.native_id)
    await expect(
      bootstrap.authorize(runner.id, authorization, { ...command, fingerprint: '0'.repeat(64), operation: 'start' }),
    ).rejects.toThrow('does not match its reservation')
    await bootstrap.authorize(runner.id, authorization, { ...command, operation: 'start' })
    await expect(bootstrap.authorize(runner.id, authorization, { ...command, operation: 'start' })).rejects.toThrow(
      'reservation is unavailable',
    )
    await expect(
      repository.updateWhere(box.id, {
        whereCondition: { state: BoxState.STARTING },
        updateData: { state: BoxState.STARTED },
      }),
    ).rejects.toThrow(BoxConflictError)
    expect((await store.read(box.id, org)).state).toBe(BoxState.STARTING)
    await bootstrap.beginRetirement(box.id, key)
    const evidence = (outcome: 'confirmed' | 'retired', allocationClosed = false) => ({
      box_id: box.id,
      receipt: { key, epoch: 'runtime-epoch', outcome, nativeId: command.native_id, allocationClosed },
    })
    await expect(bootstrap.settle(box.id, key, evidence('confirmed'))).rejects.toThrow('does not match its phase')
    await expect(bootstrap.settle(box.id, key, evidence('retired'))).rejects.toThrow('does not match its phase')
    await bootstrap.settle(box.id, key, evidence('retired', true))
    const settled = await store.read(box.id, org)
    expect(settled.state).toBe(BoxState.STOPPED)
    expect(outboundRecord(settled).bootstrap).toBeUndefined()
    expect(outboundRecord(settled).bootstrapRetirement?.epoch).toBe('runtime-epoch')
    expect(
      (await primary.getRepository(BoxLastActivity).findOneByOrFail({ boxId: box.id })).lastActivityAt,
    ).toBeDefined()
    expect(emit).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(emit.mock.calls[0])).not.toContain('bootstrapRetirement')
    await expect(
      repository.updateWhere(box.id, {
        whereCondition: { state: BoxState.STOPPED },
        updateData: { state: BoxState.STARTED },
      }),
    ).rejects.toThrow(BoxConflictError)

    const replacement = { ...key, attempt_id: randomUUID() }
    await bootstrap.reserve(settled, replacement, fingerprint, fingerprint)
    await bootstrap.prepared(box.id, replacement, command.native_id)
    await bootstrap.authorize(runner.id, authorization, { ...command, key: replacement, operation: 'start' })
    const confirmation = {
      box_id: box.id,
      receipt: { key: replacement, epoch: 'replacement-epoch', outcome: 'confirmed', nativeId: command.native_id },
    }
    await expect(
      bootstrap.settle(box.id, replacement, {
        ...confirmation,
        receipt: { ...confirmation.receipt, nativeId: 'different-native-box' },
      }),
    ).rejects.toThrow('no longer owns the assignment')
    proxy.arm('after')
    await bootstrap.settle(box.id, replacement, confirmation)
    await bootstrap.settle(box.id, replacement, confirmation)
    const confirmed = await store.read(box.id, org)
    expect(confirmed.state).toBe(BoxState.STARTED)
    expect(outboundRecord(confirmed).bootstrap).toMatchObject({ phase: 'confirmed', epoch: 'replacement-epoch' })
    expect(emit).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(emit.mock.calls[1])).not.toContain('replacement-epoch')
    await expect(bootstrap.beginRetirement(box.id, replacement, undefined, true)).rejects.toThrow('already settled')

    await primary
      .getRepository(Runner)
      .save(new Runner({ name: randomUUID(), apiKey: token, apiVersion: '2', region: org }))
    await expect(bootstrap.identity(runner.id, authorization)).rejects.toThrow('ambiguous')
  })

  it('authorizes only the matching Runner through the live private HTTPS controller', async () => {
    const owners = primary.getRepository(Runner)
    const saveRunner = () =>
      owners.save(
        new Runner({
          name: randomUUID(),
          apiKey: randomUUID(),
          apiVersion: '0',
          region: org,
          apiUrl: 'https://runner.example.test',
        }),
      )
    const owner = await saveRunner()
    const other = await saveRunner()
    await primary.getRepository(Box).update(box.id, { state: BoxState.STARTING, runnerId: owner.id, pending: true })
    const boxes = new BoxRepository(primary, { emit: jest.fn() } as never, { invalidate: jest.fn() } as never)
    const bootstrap = new ProtectedBootstrapService(transport, boxes)
    const strategy = new ApiKeyStrategy(
      { get: async () => null } as never,
      {
        getApiKeyByValue: async () => {
          throw new Error('not a user key')
        },
      } as never,
      {} as never,
      { get: () => undefined } as never,
      { findByApiKey: (apiKey: string) => owners.findOneBy({ apiKey }) } as never,
      { findOneByProxyApiKey: async () => null } as never,
    )
    const module = await Test.createTestingModule({
      controllers: [ProtectedBootstrapController],
      providers: [
        { provide: ProtectedBootstrapService, useValue: bootstrap },
        { provide: ApiKeyStrategy, useValue: strategy },
      ],
    }).compile()
    const directory = mkdtempSync(join(tmpdir(), 'protected-callback-'))
    try {
      const keyFile = join(directory, 'server.key')
      const certFile = join(directory, 'server.crt')
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-days',
          '1',
          '-subj',
          '/CN=127.0.0.1',
          '-addext',
          'subjectAltName=IP:127.0.0.1',
          '-keyout',
          keyFile,
          '-out',
          certFile,
        ],
        { stdio: 'ignore' },
      )
      const cert = readFileSync(certFile)
      const app = module.createNestApplication({
        logger: false,
        httpsOptions: { cert, key: readFileSync(keyFile) },
      })
      try {
        app.setGlobalPrefix('api')
        const client = axios.create({ httpsAgent: new Agent({ ca: cert }), validateStatus: () => true, proxy: false })
        await app.listen(0, '127.0.0.1')
        const url = `${await app.getUrl()}/api/runners/protected-bootstrap`
        const key: ProtectedBootKey = {
          runner_id: owner.id,
          attempt_id: randomUUID(),
          registration_id: randomUUID(),
          registration_revision: '1',
          policy: persistedOutbound(await store.read(box.id, org)),
        }
        const fingerprint = 'f'.repeat(64)
        await bootstrap.reserve(box, key, fingerprint, fingerprint)
        const identity = await client.get(`${url}/identity`, { headers: { Authorization: `Bearer ${owner.apiKey}` } })
        expect(identity.status).toBe(200)
        expect(identity.data).toEqual({ runner_id: owner.id })
        const command = { box_id: box.id, key, fingerprint, native_id: 'fixture-native', operation: 'start' }
        await bootstrap.prepared(box.id, key, command.native_id)
        const authorize = (apiKey: string, request: object) =>
          client.post(`${url}/authorize`, request, {
            headers: { Authorization: `Bearer ${apiKey}` },
          })
        const foreign = await authorize(other.apiKey, command)
        expect(foreign.status).toBe(403)
        const changed = await authorize(owner.apiKey, { ...command, fingerprint: '0'.repeat(64) })
        expect(changed.status).toBe(403)
        expect(outboundRecord(await store.read(box.id, org)).bootstrap?.phase).toBe('reserved')
        const allowed = await authorize(owner.apiKey, command)
        expect(allowed.status).toBe(200)
        expect(allowed.data).toMatchObject({ runner_id: owner.id, native_id: command.native_id })
        expect(outboundRecord(await store.read(box.id, org)).bootstrap?.phase).toBe('claimed')
        const repeated = await authorize(owner.apiKey, command)
        expect(repeated.status).toBe(403)

        if (process.env.BOXLITE_TEST_REAL_RUNNER === '1') {
          const disposablePort = createServer()
          await new Promise<void>((resolve) => disposablePort.listen(0, '127.0.0.1', resolve))
          const { port } = disposablePort.address() as AddressInfo
          await new Promise<void>((resolve) => disposablePort.close(() => resolve()))
          const runnerURL = `https://127.0.0.1:${port}`
          await owners.update(owner.id, { apiUrl: runnerURL, proxyUrl: runnerURL })
          const previousRunnerRoot = process.env.BOXLITE_TEST_PREVIOUS_RUNNER_ROOT
          if (previousRunnerRoot) chmodSync(directory, 0o755)
          const runnerFilter = 'TestProtectedRunnerExternalControl'
          const startRunner = async (cwd: string, version: string) => {
            const stopFile = join(directory, `stop-runner-${version}`)
            const args = ['test:apps:runner', 'SETUP_DONE=1', `FILTER=${runnerFilter}`]
            if (previousRunnerRoot) args.push(`GOTEST_FILTER=-run ${runnerFilter} -exec "sudo -n -E"`)
            const worker = spawn('make', args, {
              cwd,
              env: {
                ...process.env,
                BOXLITE_API_URL: `${await app.getUrl()}/api`,
                BOXLITE_LISTEN_HOST: '127.0.0.1',
                BOXLITE_RUNNER_TOKEN: owner.apiKey,
                BOXLITE_TEST_PROTECTED_RUNNER_PORT: String(port),
                BOXLITE_TEST_PROTECTED_RUNNER_STOP_FILE: stopFile,
                BOXLITE_TEST_PROTECTED_RUNTIME_HOME: join(directory, 'runtime'),
                RUNNER_DOMAIN: '127.0.0.1',
                TLS_CERT_FILE: certFile,
                TLS_KEY_FILE: keyFile,
                ENVIRONMENT: 'development',
              },
            })
            let output = ''
            worker.stdout.on('data', (data) => {
              output += String(data)
            })
            worker.stderr.on('data', (data) => {
              output += String(data)
            })
            const exited = new Promise<number | null>((resolve) => {
              worker.once('exit', resolve)
              worker.once('error', () => resolve(null))
            })
            const stop = async () => {
              writeFileSync(stopFile, '')
              if ((await exited) !== 0) throw new Error(output)
            }
            const deadline = Date.now() + 65000
            while (Date.now() < deadline) {
              if (worker.exitCode !== null) throw new Error(output)
              const health = await client.get(`${runnerURL}/`, { timeout: 250 }).catch(() => undefined)
              if (health?.status === 200) return stop
              await new Promise((resolve) => setTimeout(resolve, 150))
            }
            await stop()
            throw new Error(`Runner did not become healthy\n${output}`)
          }
          if (previousRunnerRoot) {
            const stopPrevious = await startRunner(previousRunnerRoot, 'previous')
            try {
              const legacy = await client.get(`${runnerURL}/v1/outbound-proxy/bootstrap`, {
                headers: { Authorization: `Bearer ${owner.apiKey}`, 'X-BoxLite-Runner-Id': owner.id },
              })
              expect(legacy.status).toBe(404)
            } finally {
              await stopPrevious()
            }
          }
          const stopCurrent = await startRunner(join(__dirname, '../../../../..'), 'current')
          try {
            const newAssignment = async () => {
              const assigned = Object.assign(new Box(org, randomUUID()), {
                organizationId: org,
                osUser: 'boxlite',
                runnerId: owner.id,
                state: BoxState.STARTING,
                desiredState: BoxDesiredState.STARTED,
                pending: true,
                cpu: 1,
                mem: 1,
                disk: 2,
                entrypoint: ['/bin/sleep'],
                cmd: ['120'],
              })
              await primary.getRepository(Box).insert(assigned)
              const attempt = {
                ...key,
                attempt_id: randomUUID(),
                policy: persistedOutbound(await store.read(assigned.id, org)),
              }
              return { assigned, attempt }
            }
            const { assigned, attempt } = await newAssignment()
            const adapter = new RunnerAdapterV0(bootstrap)
            const createClient = axios.create.bind(axios)
            jest
              .spyOn(axios, 'create')
              .mockImplementationOnce((options) => createClient({ ...options, httpsAgent: new Agent({ ca: cert }) }))
            await adapter.init(await owners.findOneByOrFail({ id: owner.id }))
            const prepared = bootstrap.prepared.bind(bootstrap)
            const prepareSpy = jest.spyOn(bootstrap, 'prepared').mockImplementation(async (id, owner, nativeId) => {
              await prepared(id, owner, nativeId)
              await primary.getRepository(Box).update(id, { desiredState: BoxDesiredState.STOPPED })
            })
            await expect(
              adapter.createProtectedBox(assigned, 'alpine:latest', attempt, async () => ({
                scheme: 'https',
                host: 'provider.example.test',
                port: 443,
              })),
            ).rejects.toThrow()
            expect(prepareSpy).toHaveBeenCalledTimes(1)
            const closed = await store.read(assigned.id, org)
            expect(closed.state).toBe(BoxState.STOPPED)
            expect(outboundRecord(closed).bootstrapRetirement).toMatchObject({
              key: attempt,
              epoch: null,
              allocationClosed: true,
              noSpawn: true,
            })
            prepareSpy.mockRestore()

            if (previousRunnerRoot) {
              const { assigned: live, attempt: liveAttempt } = await newAssignment()
              const receipt = await adapter.createProtectedBox(live, 'alpine:latest', liveAttempt, async () => ({
                scheme: 'http',
                host: '11.23.0.1',
                port: 12345,
              }))
              expect(receipt).toMatchObject({ outcome: 'confirmed', key: liveAttempt })
              const started = await store.read(live.id, org)
              expect(started.state).toBe(BoxState.STARTED)
              expect(outboundRecord(started).bootstrap?.epoch).toBe(receipt.epoch)
              const retired = await adapter.retireProtectedBoot(live.id, liveAttempt, receipt.epoch ?? undefined)
              expect(retired).toMatchObject({ outcome: 'retired', epoch: receipt.epoch, allocationClosed: true })
            }
          } finally {
            await stopCurrent()
          }
        }
      } finally {
        await app.close()
      }
    } finally {
      if (process.env.BOXLITE_TEST_PREVIOUS_RUNNER_ROOT) {
        execFileSync('sudo', ['-n', 'rm', '-rf', '--', directory])
      } else {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  }, 220000)

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
