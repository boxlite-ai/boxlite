import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpServer, ServerResponse } from 'node:http'
import { createServer, Server } from 'node:https'
import { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '../../common/context/context'
import { Runner } from '../entities/runner.entity'
import { Box } from '../entities/box.entity'
import { BoxService } from '../services/box.service'
import { RunnerService } from '../services/runner.service'
import { BoxStateWaiterService } from '../services/box-state-waiter.service'
import { BoxState } from '../enums/box-state.enum'
import { BoxliteBoxController } from '../../boxlite-rest/boxlite-box.controller'
import { RunnerAdapterV0 } from './runnerAdapter.v0'
import { ProtectedBootKey } from './protected-runner'

const runnerId = '8137cc0d-5d3f-43b8-aa32-b9304740269e'

describe('Protected Runner TLS and placement', () => {
  const directory = mkdtempSync(join(tmpdir(), 'runner-enrollment-'))
  const originalEnvironments = process.env.BOXLITE_PROTECTED_PROXY_ENROLLMENTS
  let server: Server
  let endpoint: string
  let trusted: Buffer
  let untrusted: Buffer
  let otherKey: Buffer
  let trustedKey: Buffer
  let healthCalls: number
  let volumeRestarts: boolean
  let bootstrapReply: unknown
  let managedDiagnostic: unknown
  let dropPlaceholderReplies: number
  let holdPlaceholderReply: ((response: ServerResponse) => void) | undefined
  const received: { path: string; body: any }[] = []
  const boxId = '597da250-c3f6-4276-a0c2-25657a8fdeda'
  const bootPath = `/v1/boxes/${boxId}/network/outbound/bootstrap`
  const allocationPath = (attemptId: string) => `${bootPath}/allocation/${attemptId}`
  const createCert = (name: string) => {
    const crt = join(directory, `${name}.crt`)
    const key = join(directory, `${name}.key`)
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
        `/CN=${name}`,
        '-addext',
        'basicConstraints=critical,CA:TRUE',
        '-addext',
        `subjectAltName=DNS:${name}`,
        '-keyout',
        key,
        '-out',
        crt,
      ],
      { stdio: 'ignore' },
    )
    return { cert: readFileSync(crt), key: readFileSync(key) }
  }
  const adapter = async (runner: Runner) => {
    const instance = new RunnerAdapterV0()
    await instance.init(runner)
    return instance
  }
  const record = (overrides: Partial<Runner> = {}) =>
    ({
      id: runnerId,
      apiUrl: endpoint,
      apiVersion: '0',
      apiKey: 'test-bearer',
      availabilityScore: 1,
      ...overrides,
    }) as Runner
  const enroll = (ca: Buffer, url = endpoint) => {
    process.env.BOXLITE_PROTECTED_PROXY_ENROLLMENTS = JSON.stringify([{ runnerId, url, caPem: ca.toString() }])
  }

  beforeAll(async () => {
    const materials = createCert('localhost')
    trusted = materials.cert
    trustedKey = materials.key
    const other = createCert('another.test')
    untrusted = other.cert
    otherKey = other.key
    server = createServer(materials, (request, response) => {
      response.setHeader('Content-Type', 'application/json')
      if (request.url === '/') {
        healthCalls++
        response.end('{"status":"ok"}')
      } else if (
        request.url === '/v1/outbound-proxy/bootstrap' &&
        request.headers.authorization === 'Bearer test-bearer' &&
        request.headers['x-boxlite-runner-id'] === runnerId
      ) {
        response.end(
          JSON.stringify(
            bootstrapReply ?? {
              runner_id: runnerId,
              version: 1,
              operations: [
                'start',
                'receipt',
                'retire',
                'release-gate',
                'seal-gate',
                'managed-route',
                'unbound-start',
                'remove-retired',
                'allocate-attempt',
                'close-allocation',
                ...(volumeRestarts ? ['restart-volumes'] : []),
              ],
            },
          ),
        )
      } else if (
        request.method === 'POST' &&
        request.headers.authorization === 'Bearer test-bearer' &&
        ((request.url?.startsWith(`${bootPath}/allocation/`) && request.headers['x-boxlite-runner-id'] === runnerId) ||
          request.url === `/v1/boxes/${boxId}/network/outbound/managed-route` ||
          ['', '/receipt', '/retire', '/release-gate', '/seal-gate'].some(
            (suffix) => request.url === bootPath + suffix,
          ))
      ) {
        let incoming = ''
        request.setEncoding('utf8')
        request.on('data', (chunk) => {
          incoming += chunk
        })
        request.on('end', () => {
          const body = JSON.parse(incoming)
          received.push({ path: request.url!, body })
          const allocation = request.url!.startsWith(`${bootPath}/allocation/`)
          if (allocation && dropPlaceholderReplies > 0) {
            dropPlaceholderReplies--
            response.destroy()
            return
          }
          if (allocation && holdPlaceholderReply) {
            holdPlaceholderReply(response)
            return
          }
          if (request.url?.endsWith('/managed-route')) {
            const route = {
              binding: null,
              snapshot: { revision: 'live-revision', policy: { mode: 'enabled', allow_net: [] } },
              diagnostic: 'synthetic-private-field',
            }
            response.end(
              JSON.stringify({
                box_id: boxId,
                receipt: {
                  runner_id: runnerId,
                  epoch: 'fixture-epoch',
                  durable: route,
                  installed: route,
                  proxy_diagnostic: managedDiagnostic,
                  pending_attempt: null,
                  unbind_settlement: 'unbind-attempt',
                  rollback: null,
                  retired_attempt: null,
                },
              }),
            )
            return
          }
          const seal = request.url === `${bootPath}/seal-gate`
          const gate = seal || request.url === `${bootPath}/release-gate`
          const boot = {
            key: request.url === bootPath || gate ? body.key : body,
            epoch: 'fixture-epoch',
            outcome: request.url?.endsWith('/retire') ? 'retired' : 'confirmed',
          }
          response.end(
            JSON.stringify(
              allocation
                ? { box_id: boxId, attempt_id: request.url!.split('/').at(-1), state: 'allocated' }
                : {
                    box_id: boxId,
                    receipt: gate
                      ? {
                          boot,
                          generation: 'fixture-generation',
                          sealed: seal,
                          closed: seal,
                        }
                      : boot,
                  },
            ),
          )
        })
      } else {
        response.writeHead(404).end()
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    endpoint = `https://localhost:${(server.address() as AddressInfo).port}`
  })

  beforeEach(() => {
    healthCalls = 0
    volumeRestarts = false
    bootstrapReply = undefined
    managedDiagnostic = undefined
    dropPlaceholderReplies = 0
    holdPlaceholderReply = undefined
    received.length = 0
    server.setSecureContext({ key: trustedKey, cert: trusted })
  })

  afterAll(async () => {
    server?.closeAllConnections()
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(directory, { recursive: true, force: true })
    if (originalEnvironments === undefined) delete process.env.BOXLITE_PROTECTED_PROXY_ENROLLMENTS
    else process.env.BOXLITE_PROTECTED_PROXY_ENROLLMENTS = originalEnvironments
  })

  it('distinguishes volume-backed restarts from the existing protected boot operations', async () => {
    enroll(trusted)
    const runner = await adapter(record())
    await expect(runner.supportsProtectedBootstrap(true)).resolves.toBe(true)
    await expect(runner.supportsProtectedBootstrap(true, true)).resolves.toBe(false)
    volumeRestarts = true
    await expect(runner.supportsProtectedBootstrap(true, true)).resolves.toBe(true)
  })

  it.each([
    ['missing operations', { runner_id: runnerId, version: 1, operations: ['start'] }, 'unsupported'],
    ['bad operation shape', { runner_id: runnerId, version: 1, operations: [null] }, 'unverified'],
    ['wrong identity', { runner_id: 'different-runner', version: 1, operations: [] }, 'unverified'],
    ['wrong protocol', { runner_id: runnerId, version: 2, operations: [] }, 'unverified'],
  ])('classifies authenticated capability evidence with %s', async (_case, reply, expected) => {
    enroll(trusted)
    bootstrapReply = reply
    const runner = await adapter(record())
    await expect(runner.protectedBootstrapCapability(true)).resolves.toBe(expected)
  })

  it('uses the deployment CA in the normal V0 health path and rejects untrusted TLS', async () => {
    enroll(trusted)
    const good = await adapter(record())
    await expect(good.healthCheck()).resolves.toBeUndefined()
    await expect(good.supportsProtectedBootstrap()).resolves.toBe(true)
    enroll(untrusted)
    const bad = await adapter(record())
    await expect(bad.healthCheck()).rejects.toThrow()
    await expect(bad.supportsProtectedBootstrap()).resolves.toBe(false)
    expect(healthCalls).toBe(1)
  })

  it('rejects a trusted certificate whose SAN does not match the enrolled name', async () => {
    server.setSecureContext({ key: otherKey, cert: untrusted })
    enroll(untrusted)
    const wrongName = await adapter(record())
    await expect(wrongName.healthCheck()).rejects.toThrow()
    await expect(wrongName.supportsProtectedBootstrap()).resolves.toBe(false)
    expect(healthCalls).toBe(0)
  })

  it('selects the enrolled V0 even when over ten higher scoring Runners are ineligible', async () => {
    enroll(trusted)
    const best = record()
    const higher = Array.from({ length: 12 }, (_, i) =>
      record({ id: `v2-${i}`, apiVersion: '2', availabilityScore: 100 + i }),
    )
    const anotherV0 = record({ id: 'unenrolled-v0', availabilityScore: 201 })
    const factory = { create: jest.fn(adapter) }
    const service = new RunnerService(
      { find: jest.fn().mockResolvedValue([...higher, anotherV0, best]) } as any,
      factory as any,
      {} as any,
      {} as any,
      { getOrThrow: () => 1 } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    )
    await expect(service.getRandomAvailableRunner({ requiresProtectedProxyBootstrap: true })).resolves.toBe(best)
    expect(factory.create).toHaveBeenCalledTimes(2)
    expect(factory.create).toHaveBeenCalledWith(best)
    expect(factory.create).not.toHaveBeenCalledWith(higher[0])
  })

  it.each([
    ['runner_proxy_tls_unsupported', ['0', '2']],
    ['runner_proxy_unsupported', ['2']],
  ])('refuses an incompatible placement with %s without probing', async (code, versions) => {
    const runners = versions.map((apiVersion) => record({ apiVersion, apiUrl: 'http://localhost:8080' }))
    const create = jest.fn(adapter)
    const service = new RunnerService(
      { find: jest.fn().mockResolvedValue(runners) } as any,
      { create } as any,
      {} as any,
      {} as any,
      { getOrThrow: () => 1 } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    )

    await expect(service.getRandomAvailableRunner({ requiresProtectedProxyBootstrap: true })).rejects.toMatchObject({
      status: 503,
      response: { code: 'outbound_create_rejected' },
      diagnostic: code,
    })
    expect(create).not.toHaveBeenCalled()
  })

  it('keeps the generic capacity error if any candidate is inconclusive', async () => {
    enroll(trusted)
    bootstrapReply = { runner_id: 'not-the-enrolled-runner', version: 1, operations: [] }
    const service = Object.create(RunnerService.prototype) as RunnerService
    Object.assign(service, {
      runnerRepository: { find: async () => [record({ apiVersion: '2' }), record()] },
      runnerAdapterFactory: { create: adapter },
      configService: { getOrThrow: () => 1 },
    })
    await expect(service.getRandomAvailableRunner({ requiresProtectedProxyBootstrap: true })).rejects.toMatchObject({
      status: 400,
      response: 'No available runners',
    })
  })

  it.each([
    [undefined, undefined],
    [{ code: 'proxy_timeout' }, undefined],
    ['future_error', undefined],
    ['proxy_timeout', 'proxy_timeout'],
  ])('decodes optional Runner diagnostic %p independently of installed evidence', async (wire, expected) => {
    enroll(trusted)
    managedDiagnostic = wire
    const chosen = await adapter(record())
    const receipt = await chosen.managedOutbound(boxId, 'fixture-epoch', { operation: 'inspect' })
    expect(receipt.installed).toEqual(receipt.durable)
    expect(receipt.installed?.snapshot.revision).toBe('live-revision')
    if (expected) expect(receipt.proxy_diagnostic).toBe(expected)
    else expect(receipt).not.toHaveProperty('proxy_diagnostic')
  })

  it('only loads the credential after the selected Runner proves bootstrap capability', async () => {
    enroll(trusted)
    const box = { id: boxId, runnerId, mem: 1, outboundEnabled: true } as Box
    const key: ProtectedBootKey = {
      runner_id: runnerId,
      attempt_id: 'fixture-attempt',
      registration_id: 'fixture-registration',
      registration_revision: '3',
      policy: { revision: 'fixture-policy', policy: { mode: 'enabled', allow_net: [] } },
    }
    const loadRoute = jest.fn(async () => ({
      scheme: 'https' as const,
      host: 'provider.example.com',
      port: 443,
      credential: { username: 'fixture-user', password: 'fixture-proxy-secret' },
    }))
    const other = await adapter(record({ id: 'unenrolled-v0' }))
    await expect(other.createProtectedBox(box, 'alpine', key, loadRoute)).rejects.toThrow()
    expect(loadRoute).not.toHaveBeenCalled()
    expect(received).toHaveLength(0)

    const chosen = await adapter(record())
    await expect(chosen.createProtectedBox(box, 'alpine', key, loadRoute)).resolves.toEqual({
      key,
      epoch: 'fixture-epoch',
      outcome: 'confirmed',
    })
    expect(loadRoute).toHaveBeenCalledTimes(1)
    expect(received).toHaveLength(2)
    expect(received[0].body).toMatchObject({ id: boxId, skipStart: true, outboundEnabled: false })
    expect(JSON.stringify(received[0].body)).not.toContain('fixture-proxy-secret')
    expect(received[1].body).toMatchObject({ key, credential: { password: 'fixture-proxy-secret' } })
    await expect(chosen.readProtectedBoot(boxId, key, 'fixture-epoch')).resolves.toMatchObject({ outcome: 'confirmed' })
    await expect(chosen.readProtectedBoot(boxId, key, 'different-epoch')).rejects.toThrow(
      'exact protected bootstrap evidence',
    )
    await expect(chosen.retireProtectedBoot(boxId, key, 'different-epoch')).rejects.toThrow(
      'exact protected bootstrap evidence',
    )
    await expect(chosen.retireProtectedBoot(boxId, key, 'fixture-epoch')).resolves.toEqual({
      key,
      epoch: 'fixture-epoch',
      outcome: 'retired',
    })
  })

  it.each(['http-only V0', 'V2-only'])(
    'refuses a credential-free managed create with %s placement before persistence or dispatch',
    async (mode) => {
      let plainRequests = 0
      const plain = createHttpServer((_request, response) => {
        plainRequests++
        response.writeHead(500).end()
      })
      await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve))
      const env = process.env.OUTBOUND_PROXY_REGISTRY_ENABLED
      process.env.OUTBOUND_PROXY_REGISTRY_ENABLED = 'true'
      try {
        const candidate = record({
          apiVersion: mode === 'V2-only' ? '2' : '0',
          apiUrl: `http://127.0.0.1:${(plain.address() as AddressInfo).port}`,
        })
        const factory = { create: jest.fn(adapter) }
        const candidates = jest.fn().mockResolvedValue([candidate])
        const runnerService = Object.create(RunnerService.prototype) as RunnerService
        Object.assign(runnerService, {
          runnerRepository: { find: candidates },
          runnerAdapterFactory: factory,
          configService: { getOrThrow: () => 1 },
        })
        const insert = jest.fn()
        const seed = jest.fn()
        const spendColdPullBudget = jest.fn()
        const service = Object.create(BoxService.prototype) as BoxService
        Object.assign(service, {
          runnerService,
          regionService: { findOne: async () => ({ id: 'isolated-region' }) },
          organizationService: {
            isNestedVirtualizationEnabled: async () => false,
            assertOrganizationIsNotSuspended: jest.fn(),
          },
          organizationBoxLimits: { resolve: async () => ({ maxCpuPerBox: 0, maxMemoryPerBox: 0, maxDiskPerBox: 0 }) },
          imageAdmissionService: { assert: async () => undefined, spendColdPullBudget },
          imageResolverService: { resolve: async () => ({ ref: 'alpine', isOrgOwned: true }) },
          outboundBootstrap: { resolveName: async () => ({ credential_configured: false }), seed },
          boxRepository: { insert },
        })
        await expect(
          service.create(
            { name: 'isolated-box', image: 'alpine' } as never,
            { id: 'fixture-org', defaultRegionId: 'isolated-region' } as never,
            Context.user(),
            { outboundProxy: 'existing-registry-name' },
          ),
        ).rejects.toMatchObject({
          status: 503,
          response: { code: 'outbound_create_rejected' },
          diagnostic: mode === 'V2-only' ? 'runner_proxy_unsupported' : 'runner_proxy_tls_unsupported',
        })
        expect(candidates).toHaveBeenCalledTimes(1)
        expect(factory.create).not.toHaveBeenCalled()
        expect(insert).not.toHaveBeenCalled()
        expect(seed).not.toHaveBeenCalled()
        expect(spendColdPullBudget).not.toHaveBeenCalled()
        expect(plainRequests).toBe(0)
        expect(received).toHaveLength(0)
      } finally {
        if (env === undefined) delete process.env.OUTBOUND_PROXY_REGISTRY_ENABLED
        else process.env.OUTBOUND_PROXY_REGISTRY_ENABLED = env
        plain.closeAllConnections()
        await new Promise<void>((resolve) => plain.close(() => resolve()))
      }
    },
  )

  it.each([1, 4])('preserves placeholder identity when %d Runner replies are lost', async (lost) => {
    enroll(trusted)
    dropPlaceholderReplies = lost
    const chosen = await adapter(record())
    const box = { id: boxId, runnerId, mem: 1, outboundEnabled: true } as Box
    const key: ProtectedBootKey = {
      runner_id: runnerId,
      attempt_id: 'd0ad34d5-7fc4-409b-8b78-69a185967a2c',
      registration_id: 'fixture-registration',
      registration_revision: '1',
      policy: { revision: 'fixture-policy', policy: { mode: 'enabled', allow_net: [] } },
    }
    const loadRoute = jest.fn(async () => ({
      scheme: 'https' as const,
      host: 'fixture-proxy.example',
      port: 443,
      credential: { username: 'fixture-user', password: 'fixture-proxy-secret' },
    }))
    const creation = chosen.createProtectedBox(box, 'alpine', key, loadRoute)
    const path = allocationPath(key.attempt_id)
    if (lost === 1) {
      await expect(creation).resolves.toEqual({ key, epoch: 'fixture-epoch', outcome: 'confirmed' })
      expect(loadRoute).toHaveBeenCalledTimes(1)
      expect(received.map(({ path }) => path)).toEqual([path, path, bootPath])
      expect(received.at(-1)?.body.key).toEqual(key)
    } else {
      await expect(creation).rejects.toThrow()
      expect(loadRoute).not.toHaveBeenCalled()
      expect(received.map(({ path }) => path)).toEqual([path, path, path, path])
    }
    expect(dropPlaceholderReplies).toBe(0)
    const placeholders = received.filter((entry) => entry.path === path).map(({ body }) => body)
    for (const body of placeholders) {
      expect(body).toEqual(placeholders[0])
      expect(body).toMatchObject({ id: boxId, skipStart: true, outboundEnabled: false })
      expect(JSON.stringify(body)).not.toContain('fixture-proxy-secret')
    }
  })

  it('returns the admitted Box after the public wait while the first Runner reply is still held', async () => {
    enroll(trusted)
    const entered = new Promise<ServerResponse>((resolve) => {
      holdPlaceholderReply = resolve
    })
    const chosen = await adapter(record())
    const box = { id: boxId, runnerId, mem: 1, state: BoxState.CREATING, outboundEnabled: true } as Box
    const key: ProtectedBootKey = {
      runner_id: runnerId,
      attempt_id: '7595ae75-28aa-4a00-8690-cc66ac7b7daf',
      registration_id: 'fixture-registration',
      registration_revision: '1',
      policy: { revision: 'fixture-policy', policy: { mode: 'enabled', allow_net: [] } },
    }
    const loadRoute = jest.fn()
    const runnerCall = chosen.createProtectedBox(box, 'alpine', key, loadRoute)
    const settled = jest.fn()
    const cleanup = runnerCall.then(settled, settled)
    const boxService = {
      create: jest.fn().mockResolvedValue(box),
      findOneByIdOrName: jest.fn().mockResolvedValue(box),
      toBoxDto: jest.fn().mockResolvedValue({}),
    }
    const subscriber = { on: jest.fn(), subscribe: jest.fn().mockResolvedValue(1), quit: jest.fn() }
    const waiter = new BoxStateWaiterService(boxService as never, { duplicate: () => subscriber } as never)
    const route = new BoxliteBoxController(
      boxService as never,
      waiter,
      { resolveMaxCreatedBoxes: jest.fn() } as never,
      {} as never,
    )
    let held: ServerResponse | undefined
    try {
      held = await Promise.race([
        entered,
        runnerCall.then(() => Promise.reject(new Error('Runner returned before its placeholder reply was held'))),
      ])
      const started = performance.now()
      await expect(
        route.createBox(
          { organization: { id: 'fixture-org' } } as never,
          { image: 'alpine', network: { outbound: { mode: 'enabled', proxy: 'fixture-proxy' } } } as never,
          Context.user(),
        ),
      ).rejects.toMatchObject({ status: 408, response: { code: 'outbound_create_admitted', boxId } })
      expect(performance.now() - started).toBeGreaterThanOrEqual(29_900)
      expect(settled).not.toHaveBeenCalled()
      expect(loadRoute).not.toHaveBeenCalled()
      expect(received.map(({ path }) => path)).toEqual([allocationPath(key.attempt_id)])
      expect(received[0].body).toMatchObject({ id: boxId, skipStart: true, outboundEnabled: false })
      expect(boxService.create).toHaveBeenCalledTimes(1)
    } finally {
      held?.writeHead(422, { 'Content-Type': 'application/json' }).end('{"message":"fixture end"}')
      await cleanup
      await waiter.onModuleDestroy()
    }
    expect(settled).toHaveBeenCalledTimes(1)
    expect(received.map(({ path }) => path)).toEqual([allocationPath(key.attempt_id)])
  }, 45_000)

  it('requires exact epoch, generation and gate state in the enrolled Runner receipt', async () => {
    enroll(trusted)
    const chosen = await adapter(record())
    const key: ProtectedBootKey = {
      runner_id: runnerId,
      attempt_id: 'fixture-attempt',
      registration_id: 'fixture-registration',
      registration_revision: '3',
      policy: { revision: 'fixture-policy', policy: { mode: 'enabled', allow_net: [] } },
    }
    expect(await chosen.supportsProtectedBootstrap(true)).toBe(true)
    await expect(
      chosen.changeProtectedBootGate(boxId, key, 'fixture-epoch', 'fixture-generation', 'seal'),
    ).resolves.toBeUndefined()
    await expect(
      chosen.changeProtectedBootGate(boxId, key, 'fixture-epoch', 'different-generation', 'release'),
    ).rejects.toThrow('exact protected recovery gate change')
    await expect(
      chosen.changeProtectedBootGate(boxId, key, 'different-epoch', 'fixture-generation', 'seal'),
    ).rejects.toThrow('exact protected bootstrap evidence')
  })

  it('uses the enrolled channel for managed route readback and verifies scope', async () => {
    enroll(trusted)
    const chosen = await adapter(record())
    const receipt = await chosen.managedOutbound(boxId, 'fixture-epoch', { operation: 'inspect' })
    expect(receipt.durable.binding).toBeNull()
    expect(receipt.unbind_settlement).toBe('unbind-attempt')
    expect(JSON.stringify(receipt)).not.toContain('synthetic-private-field')
    await expect(chosen.managedOutbound(boxId, 'stale-epoch', { operation: 'inspect' })).rejects.toThrow(
      'exact managed outbound evidence',
    )
  })
})
