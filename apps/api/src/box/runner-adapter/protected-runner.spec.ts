import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { Agent, createServer, Server } from 'node:https'
import { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import axios from 'axios'
import { ConflictException } from '@nestjs/common'
import { Runner } from '../entities/runner.entity'
import { Box } from '../entities/box.entity'
import { RunnerService } from '../services/runner.service'
import { ProtectedBootstrapService } from '../services/protected-bootstrap.service'
import { OutboundCommitUnknown } from '../stores/outbound-policy.store'
import { RunnerAdapterV0 } from './runnerAdapter.v0'
import { ProtectedBootKey } from './protected-runner'

const runnerId = '8137cc0d-5d3f-43b8-aa32-b9304740269e'

describe('Protected Runner TLS and placement', () => {
  const directory = mkdtempSync(join(tmpdir(), 'runner-tls-'))
  const createClient = axios.create.bind(axios)
  let server: Server
  let endpoint: string
  let trusted: Buffer
  let untrusted: Buffer
  let deploymentCA: Buffer
  let otherKey: Buffer
  let trustedKey: Buffer
  let healthCalls: number
  const received: { path: string; body: any }[] = []
  const boxId = '597da250-c3f6-4276-a0c2-25657a8fdeda'
  const bootPath = `/v1/boxes/${boxId}/network/outbound/bootstrap`
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
  const bootstrapStub = () => ({
    reserve: jest.fn(),
    prepared: jest.fn(),
    settle: jest.fn(),
    beginRetirement: jest.fn(async (_box: string, _key: ProtectedBootKey, epoch?: string) => epoch),
  })
  const adapter = async (runner: Runner, bootstrap = bootstrapStub()) => {
    const instance = new RunnerAdapterV0(bootstrap as unknown as ProtectedBootstrapService)
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
          JSON.stringify({ runner_id: runnerId, version: 1, operations: ['prepare', 'start', 'receipt', 'retire'] }),
        )
      } else if (
        request.method === 'POST' &&
        request.headers.authorization === 'Bearer test-bearer' &&
        [bootPath, `${bootPath}/prepare`, `${bootPath}/receipt`, `${bootPath}/retire`].includes(request.url ?? '')
      ) {
        let incoming = ''
        request.setEncoding('utf8')
        request.on('data', (chunk) => {
          incoming += chunk
        })
        request.on('end', () => {
          const body = JSON.parse(incoming)
          received.push({ path: request.url!, body })
          response.end(
            JSON.stringify(
              request.url === `${bootPath}/prepare`
                ? { box_id: boxId, native_id: 'prepared-box' }
                : {
                    box_id: boxId,
                    receipt: {
                      key: request.url === bootPath ? body.key : body,
                      epoch: 'fixture-epoch',
                      outcome: request.url?.endsWith('/retire') ? 'retired' : 'confirmed',
                    },
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
    received.length = 0
    deploymentCA = trusted
    server.setSecureContext({ key: trustedKey, cert: trusted })
    // Supply the test CA at the transport boundary as the host trust store would.
    jest.spyOn(axios, 'create').mockImplementation((config) =>
      createClient({
        ...config,
        httpsAgent: new Agent({ ...config?.httpsAgent?.options, ca: deploymentCA }),
      }),
    )
  })

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    server?.closeAllConnections()
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(directory, { recursive: true, force: true })
  })

  it('probes a normally trusted V0 HTTPS endpoint without proxy enrollment', async () => {
    const runner = await adapter(record())
    await expect(runner.healthCheck()).resolves.toBeUndefined()
    await expect(runner.supportsProtectedBootstrap()).resolves.toBe(true)
  })

  it('reconciles a lost reservation reply using the original fingerprints before dispatch', async () => {
    const bootstrap = bootstrapStub()
    bootstrap.reserve.mockRejectedValueOnce(new OutboundCommitUnknown(new Error('lost commit reply')))
    const runner = await adapter(record(), bootstrap)
    const box = { id: boxId, runnerId, mem: 1, outboundEnabled: true } as Box
    const key: ProtectedBootKey = {
      runner_id: runnerId,
      attempt_id: 'fixture-attempt',
      registration_id: 'fixture-registration',
      registration_revision: '3',
      policy: { revision: 'fixture-policy', policy: { mode: 'enabled', allow_net: [] } },
    }

    await expect(
      runner.createProtectedBox(box, 'alpine', key, async () => ({
        scheme: 'https',
        host: 'provider.example.com',
        port: 443,
      })),
    ).resolves.toMatchObject({ outcome: 'confirmed' })
    expect(bootstrap.reserve).toHaveBeenCalledTimes(2)
    expect(bootstrap.reserve.mock.calls[1]).toEqual(bootstrap.reserve.mock.calls[0])
    expect(received.map(({ path }) => path)).toEqual([`${bootPath}/prepare`, bootPath])
  })

  it.each([new ConflictException('Box requested stop'), new Error('activity update failed')])(
    'retires a confirmed Runner launch when settlement fails with %s',
    async (failure) => {
      const bootstrap = bootstrapStub()
      bootstrap.settle.mockRejectedValueOnce(failure).mockRejectedValueOnce(failure)
      const runner = await adapter(record(), bootstrap)
      const box = { id: boxId, runnerId, mem: 1, outboundEnabled: true } as Box
      const key: ProtectedBootKey = {
        runner_id: runnerId,
        attempt_id: 'fixture-attempt',
        registration_id: 'fixture-registration',
        registration_revision: '3',
        policy: { revision: 'fixture-policy', policy: { mode: 'enabled', allow_net: [] } },
      }

      await expect(
        runner.createProtectedBox(box, 'alpine', key, async () => ({
          scheme: 'https',
          host: 'provider.example.com',
          port: 443,
        })),
      ).rejects.toThrow(failure.message)
      expect(received.map(({ path }) => path)).toEqual([
        `${bootPath}/prepare`,
        bootPath,
        `${bootPath}/receipt`,
        `${bootPath}/retire`,
      ])
      expect(bootstrap.settle).toHaveBeenCalledTimes(3)
    },
  )

  it('retires the original reservation when its recovery transaction fails before commit', async () => {
    const bootstrap = bootstrapStub()
    bootstrap.reserve
      .mockRejectedValueOnce(new OutboundCommitUnknown(new Error('lost commit reply')))
      .mockRejectedValueOnce(new Error('reservation read failed'))
    const runner = await adapter(record(), bootstrap)
    const box = { id: boxId, runnerId, mem: 1, outboundEnabled: true } as Box
    const key: ProtectedBootKey = {
      runner_id: runnerId,
      attempt_id: 'fixture-attempt',
      registration_id: 'fixture-registration',
      registration_revision: '3',
      policy: { revision: 'fixture-policy', policy: { mode: 'enabled', allow_net: [] } },
    }

    await expect(
      runner.createProtectedBox(box, 'alpine', key, async () => ({
        scheme: 'https',
        host: 'provider.example.com',
        port: 443,
      })),
    ).rejects.toThrow('reservation read failed')
    expect(received.map(({ path }) => path)).toEqual([`${bootPath}/retire`])
    expect(bootstrap.beginRetirement).toHaveBeenCalledWith(box.id, key, undefined, true)
  })

  it('rejects TLS outside the deployment trust store', async () => {
    deploymentCA = untrusted
    const bad = await adapter(record())
    await expect(bad.healthCheck()).rejects.toThrow()
    await expect(bad.supportsProtectedBootstrap()).resolves.toBe(false)
    expect(healthCalls).toBe(0)
  })

  it('rejects a trusted certificate whose SAN does not match the registered endpoint', async () => {
    server.setSecureContext({ key: otherKey, cert: untrusted })
    deploymentCA = untrusted
    const wrongName = await adapter(record())
    await expect(wrongName.healthCheck()).rejects.toThrow()
    await expect(wrongName.supportsProtectedBootstrap()).resolves.toBe(false)
    expect(healthCalls).toBe(0)
  })

  it('selects the HTTPS V0 even when over ten higher scoring Runners are ineligible', async () => {
    const best = record()
    const higher = Array.from({ length: 12 }, (_, i) =>
      record({ id: `v2-${i}`, apiVersion: '2', availabilityScore: 100 + i }),
    )
    const anotherV0 = record({ id: 'wrong-runner-id', availabilityScore: 201 })
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

  it('only loads the credential after the selected Runner proves bootstrap capability', async () => {
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
    const other = await adapter(record({ id: 'wrong-runner-id' }))
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
    expect(received[0].body).toMatchObject({
      key,
      configuration: { id: boxId, skipStart: true, outboundEnabled: false },
    })
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
})
