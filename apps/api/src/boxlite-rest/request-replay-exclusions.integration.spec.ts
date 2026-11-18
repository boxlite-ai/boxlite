/// <reference lib="es2024.promise" />
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { ExecutionContext, INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import Redis from 'ioredis'
import { WebSocket, WebSocketServer } from 'ws'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { BoxService } from '../box/services/box.service'
import { RunnerService } from '../box/services/runner.service'
import { BoxAutoResumeService } from '../box/services/box-auto-resume.service'
import { TunnelService } from '../box/services/tunnel.service'
import { BoxliteProxyController } from './boxlite-proxy.controller'
import { BoxliteWsProxyService } from './boxlite-ws-proxy.service'
import { BoxRequestReplayService } from './box-request-replay.service'
import { RequestReplayInterceptor } from './request-replay.interceptor'

jest.mock('http-proxy-middleware', () =>
  process.getBuiltinModule('node:module').createRequire(__filename)('http-proxy-middleware'),
)
const describeWithRedis = process.env.REDIS_HOST ? describe : describe.skip

/** Requests cross the real HTTP/upgrade and proxy boundaries; no proxy middleware mocks. */
describeWithRedis('Request replay unsupported transport boundaries', () => {
  const org = `exclusions-${randomUUID()}`
  const boxId = randomUUID()
  const caller = { userId: 'transport-user', organizationId: org, organization: { id: org } }
  let redis: Redis
  let app: INestApplication
  let runner: Server
  let runnerWs: WebSocketServer
  let base: string
  let guestFile: Buffer | undefined
  let attachCount = 0
  let wsService: BoxliteWsProxyService
  const clients = new Set<WebSocket>()
  const tunnels = new Map<number, { token_hash: string | null; token_mask: string | null }>()
  const tunnelQuery = jest.fn(async (_query: string, args: [string, number, string, string | null, string | null]) => {
    const [, port, , hash, mask] = args
    if (!tunnels.has(port)) tunnels.set(port, { token_hash: hash, token_mask: mask })
    return [tunnels.get(port)!]
  })
  const boxService = {
    findOneByIdOrName: jest.fn(async () => ({
      id: boxId,
      organizationId: org,
      runnerId: 'runner',
      inboundEnabled: true,
      state: 'started',
      desiredState: 'started',
      autoResume: true,
    })),
    updateLastActivityAt: jest.fn(async () => undefined),
    getNetworkTunnelUrl: jest.fn(async (_box: string, _org: string, port: number) => `https://${port}.tunnel.example`),
  }
  const autoResume = { ensureReady: jest.fn(async () => undefined) }
  const consumeTicket = jest.fn(async () => null)
  const authenticateKey = jest.fn(async () => ({
    userId: 'transport-user',
    organizationId: org,
    permissions: [OrganizationResourcePermission.WRITE_BOXES],
  }))
  const audit = { createLog: jest.fn(async () => ({ id: randomUUID() })), updateLog: jest.fn(async () => undefined) }

  beforeAll(async () => {
    redis = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT || 6379),
      username: process.env.REDIS_USERNAME || undefined,
      password: process.env.REDIS_PASSWORD || undefined,
    })
    await redis.ping()
    runnerWs = new WebSocketServer({ noServer: true })
    runner = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        guestFile = Buffer.concat(chunks)
        res.writeHead(204)
        res.end()
      })
    })
    runner.on('upgrade', (req, socket, head) => {
      attachCount++
      runnerWs.handleUpgrade(req, socket, head, (ws) => {
        clients.add(ws)
        ws.on('message', (message) => ws.send(message))
        ws.on('close', () => clients.delete(ws))
      })
    })
    runner.listen(0, '127.0.0.1')
    await once(runner, 'listening')
    const runnerService = {
      findOne: async () => ({
        apiUrl: `http://127.0.0.1:${(runner.address() as AddressInfo).port}`,
        apiKey: 'runner-secret',
      }),
    }
    const tunnelService = new TunnelService({ query: tunnelQuery } as never, redis)
    const module = await Test.createTestingModule({
      controllers: [BoxliteProxyController],
      providers: [
        BoxRequestReplayService,
        RequestReplayInterceptor,
        { provide: getRedisConnectionToken(), useValue: redis },
        { provide: BoxService, useValue: boxService },
        { provide: RunnerService, useValue: runnerService },
        { provide: BoxAutoResumeService, useValue: autoResume },
        { provide: TunnelService, useValue: tunnelService },
      ],
    })
      .useMocker(() => ({}))
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          context.switchToHttp().getRequest().user = caller
          return true
        },
      })
      .overrideGuard(OrganizationResourceActionGuard)
      .useValue({ canActivate: () => true })
      .compile()
    app = module.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalInterceptors(app.get(RequestReplayInterceptor))
    wsService = new BoxliteWsProxyService(
      { getApiKeyByValue: authenticateKey } as never,
      { findOne: async () => ({ organizationId: org, userId: 'transport-user', role: 'member' }) } as never,
      { findOne: async () => ({ id: org }) } as never,
      boxService as never,
      runnerService as never,
      autoResume as never,
      { findOne: async () => ({ id: 'transport-user', role: 'user', email: 'transport@example.test' }) } as never,
      undefined,
      { consume: consumeTicket } as never,
      audit as never,
    )
    app.getHttpServer().on('upgrade', (req, socket, head) => {
      void wsService.upgrade(req, socket as Socket, head)
    })
    await app.listen(0, '127.0.0.1')
    base = await app.getUrl()
  })

  beforeEach(() => {
    guestFile = undefined
    attachCount = 0
    jest.clearAllMocks()
  })

  afterAll(async () => {
    for (const client of clients) client.terminate()
    await app?.close()
    if (runnerWs) {
      const closed = once(runnerWs, 'close')
      runnerWs.close()
      await closed
    }
    if (runner) {
      runner.closeAllConnections()
      const closed = once(runner, 'close')
      runner.close()
      await closed
    }
    if (redis) {
      const keys = await redis.keys(`replay:${org}:*`)
      if (keys.length) await redis.del(...keys)
      for (const port of tunnels.keys())
        await redis.del(`preview:tunnel-access:${boxId}:${port}`, `preview:tunnel:${boxId}:${port}`)
      await redis.quit()
    }
  })

  it('rejects keyed file upload before runner dispatch or guest writes', async () => {
    const response = await fetch(`${base}/api/v1/boxes/${boxId}/files?path=/tmp/file`, {
      method: 'PUT',
      headers: { 'Idempotency-Key': randomUUID(), 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('guest file payload'),
    })
    expect(response.status).toBe(400)
    expect(guestFile).toBeUndefined()
    expect(boxService.findOneByIdOrName).not.toHaveBeenCalled()
    expect(autoResume.ensureReady).not.toHaveBeenCalled()
  })

  it('rejects keyed file download before runner dispatch', async () => {
    const response = await fetch(`${base}/api/v1/boxes/${boxId}/files?path=/tmp/file`, {
      headers: { 'Idempotency-Key': randomUUID() },
    })
    expect(response.status).toBe(400)
    expect(boxService.findOneByIdOrName).not.toHaveBeenCalled()
    expect(autoResume.ensureReady).not.toHaveBeenCalled()
  })

  it('streams an unkeyed upload through the production helper without changing bytes', async () => {
    const payload = Buffer.from([0, 1, 2, 255, 10, 13, 0])
    const response = await fetch(`${base}/api/v1/boxes/${boxId}/files?path=/tmp/file`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: payload,
    })
    expect(response.status).toBe(204)
    expect(guestFile).toEqual(payload)
  })

  it('rejects keyed private tunnel creation before token generation or persistence', async () => {
    const response = await fetch(`${base}/api/v1/boxes/${boxId}/network/tunnel?port=3091`, {
      method: 'POST',
      headers: { 'Idempotency-Key': randomUUID(), 'Content-Type': 'application/json' },
      body: '{"isPublic":false}',
    })
    expect(response.status).toBe(400)
    expect(tunnelQuery).not.toHaveBeenCalled()
    expect(boxService.findOneByIdOrName).not.toHaveBeenCalled()
    expect(tunnels.has(3091)).toBe(false)
  })

  it('keeps unkeyed private tunnel first-token and later-masked-token semantics', async () => {
    const send = () =>
      fetch(`${base}/api/v1/boxes/${boxId}/network/tunnel?port=3092`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"isPublic":false}',
      })
    const first = await send()
    expect(first.status).toBe(200)
    const original = (await first.json()) as { token: string; isPublic: boolean }
    expect(original).toMatchObject({ isPublic: false, token: expect.stringMatching(/^blt_[A-Za-z0-9_-]{43}$/) })
    const second = await send()
    expect(second.status).toBe(200)
    expect(await second.json()).toMatchObject({ isPublic: false, token: expect.stringMatching(/^blt_\*{28}/) })
    expect(tunnelQuery).toHaveBeenCalledTimes(2)
    expect(tunnels.size).toBe(1)
  })

  it.each(
    ['', 'invalid-key', '9521e865-87b5-4ad9-8ed7-818ee4f182d4'].flatMap((key) =>
      [org, 'organizations'].map((tenant) => ({ key, tenant })),
    ),
  )('rejects keyed WebSocket $key for tenant $tenant before effects', async ({ key, tenant }) => {
    const result = Promise.withResolvers<number>()
    const request = httpRequest(
      `${base}/api/v1/${tenant}/boxes/${boxId}/executions/e1/attach?ticket=unused`,
      {
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': Buffer.alloc(16).toString('base64'),
          'Idempotency-Key': key,
        },
      },
      (response) => {
        response.resume()
        result.resolve(response.statusCode!)
      },
    )
    request.once('upgrade', (_response, socket) => {
      socket.destroy()
      result.reject(new Error('Unexpected upgrade'))
    })
    request.once('error', result.reject)
    request.end()
    expect(await result.promise).toBe(400)
    expect(consumeTicket).not.toHaveBeenCalled()
    expect(authenticateKey).not.toHaveBeenCalled()
    expect(boxService.findOneByIdOrName).not.toHaveBeenCalled()
    expect(autoResume.ensureReady).not.toHaveBeenCalled()
    expect(audit.createLog).not.toHaveBeenCalled()
    expect(attachCount).toBe(0)
  })

  it('preserves unkeyed WebSocket attach and its guest byte stream', async () => {
    const client = new WebSocket(`${base.replace('http:', 'ws:')}/api/v1/${org}/boxes/${boxId}/executions/e1/attach`, {
      headers: { Authorization: 'Bearer transport-key' },
    })
    clients.add(client)
    await once(client, 'open')
    const message = once(client, 'message')
    client.send('guest stdin')
    const [echo] = await message
    expect(Buffer.from(echo).toString()).toBe('guest stdin')
    expect(attachCount).toBe(1)
    expect(audit.createLog).toHaveBeenCalledTimes(1)
    const closed = once(client, 'close')
    client.close()
    await closed
    clients.delete(client)
  })
})
