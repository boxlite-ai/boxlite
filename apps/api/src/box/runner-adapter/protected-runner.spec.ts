import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, Server } from 'node:https'
import { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Runner } from '../entities/runner.entity'
import { Box } from '../entities/box.entity'
import { RunnerService } from '../services/runner.service'
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
          JSON.stringify({
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
              ...(volumeRestarts ? ['restart-volumes'] : []),
            ],
          }),
        )
      } else if (
        request.method === 'POST' &&
        request.headers.authorization === 'Bearer test-bearer' &&
        (request.url === '/boxes' ||
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
              request.url === '/boxes'
                ? { daemonVersion: 'boxlite' }
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
