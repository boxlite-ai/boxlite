/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import type { Request } from 'express'
import { Socket } from 'node:net'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import { ExecutionContext, INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import Redis from 'ioredis'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { BoxService } from '../box/services/box.service'
import { RunnerService } from '../box/services/runner.service'
import { BoxAutoResumeService } from '../box/services/box-auto-resume.service'
import { TunnelService } from '../box/services/tunnel.service'
import { BoxliteProxyController } from './boxlite-proxy.controller'
import { BoxRequestReplayService } from './box-request-replay.service'
import { RequestReplayInterceptor } from './request-replay.interceptor'
import { HttpAdapterHost } from '@nestjs/core'
import { McpDispatcher } from '../mcp/mcp-dispatcher'
import { McpCatalog } from '../mcp/mcp-catalog'
import { McpDelegation } from '../auth/mcp-delegation'
import { BoxliteWsProxyService } from './boxlite-ws-proxy.service'

jest.mock('http-proxy-middleware', () =>
  process.getBuiltinModule('node:module').createRequire(__filename)('http-proxy-middleware'),
)
const describeWithRedis = process.env.REDIS_HOST ? describe : describe.skip

describeWithRedis('Request replay through the production HTTP runner proxy', () => {
  const organizationId = `proxy-replay-${randomUUID()}`
  const caller = {
    userId: 'proxy-user',
    email: 'proxy@example.test',
    role: 'user',
    organizationId,
    organization: { id: organizationId },
  }
  let redis: Redis
  let app: INestApplication
  let runner: Server
  let base: string
  let reply: (req: IncomingMessage, res: ServerResponse) => void
  let dispatcher: McpDispatcher | undefined
  let runnerCalls = 0
  const boxService = {
    findOneByIdOrName: jest.fn(async (id: string) => ({
      id,
      organizationId,
      runnerId: 'runner',
      autoResume: false,
      state: 'started',
      desiredState: 'started',
    })),
    updateLastActivityAt: jest.fn(async () => undefined),
  }
  const autoResume = { ensureReady: jest.fn(async () => undefined) }

  beforeAll(async () => {
    redis = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT || 6379),
      username: process.env.REDIS_USERNAME || undefined,
      password: process.env.REDIS_PASSWORD || undefined,
    })
    await redis.ping()
    runner = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        runnerCalls++
        reply(req, res)
      })
    })
    runner.listen(0, '127.0.0.1')
    await once(runner, 'listening')
    const runnerUrl = `http://127.0.0.1:${(runner.address() as AddressInfo).port}`
    const module = await Test.createTestingModule({
      controllers: [BoxliteProxyController],
      providers: [
        BoxRequestReplayService,
        RequestReplayInterceptor,
        { provide: getRedisConnectionToken(), useValue: redis },
        { provide: BoxService, useValue: boxService },
        { provide: RunnerService, useValue: { findOne: async () => ({ apiUrl: runnerUrl, apiKey: 'runner-secret' }) } },
        { provide: BoxAutoResumeService, useValue: autoResume },
        { provide: TunnelService, useValue: {} },
      ],
    })
      .useMocker(() => ({}))
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const req = context.switchToHttp().getRequest<Request>()
          if (req.headers['x-boxlite-mcp-delegation']) return new CombinedAuthGuard().canActivate(context)
          req.user = caller
          return true
        },
      })
      .overrideGuard(OrganizationResourceActionGuard)
      .useValue({ canActivate: () => true })
      .compile()
    app = module.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalInterceptors(app.get(RequestReplayInterceptor))
    await app.listen(0, '127.0.0.1')
    base = await app.getUrl()
  })

  beforeEach(() => {
    runnerCalls = 0
    jest.clearAllMocks()
    reply = (_req, res) => {
      res.writeHead(201, { 'Content-Type': 'application/json', Location: '/executions/original-execution' })
      res.end('{ "execution_id": "original-execution" }\n')
    }
  })

  afterAll(async () => {
    await dispatcher?.onModuleDestroy()
    await app?.close()
    if (runner) {
      runner.closeAllConnections()
      const closed = once(runner, 'close')
      runner.close()
      await closed
    }
    if (redis) {
      const keys = await redis.keys(`replay:${organizationId}:*`)
      if (keys.length) await redis.del(...keys)
      await redis.quit()
    }
  })

  const send = (method: string, path: string, key: string, body?: unknown) =>
    fetch(`${base}/api/v1/boxes/${path}`, {
      method,
      headers: { 'Idempotency-Key': key, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

  async function waitForState(key: string, expected = ['complete']) {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      const hash = createHash('sha256').update(key).digest('hex')
      const keys = await redis.keys(`replay:${organizationId}:*:${hash}`)
      const states = await Promise.all(keys.map((record) => redis.hget(record, 'state')))
      if (states.some((state) => state !== null && expected.includes(state))) return
      await delay(5)
    }
    throw new Error(`The proxy response did not reach replay state ${expected.join(' or ')}`)
  }

  it.each([
    ['POST', 'exec', 201, { command: '/bin/echo', args: ['hello'] }],
    ['POST', 'executions/e1/signal', 204, { signal: 'TERM' }],
  ] as const)('replays %s %s status %s without another runner operation', async (method, suffix, status, body) => {
    if (status === 204) reply = (_req, res) => res.writeHead(204).end()
    const boxId = randomUUID()
    const key = randomUUID()
    const path = `${boxId}/${suffix}`
    const first = await send(method, path, key, body)
    const originalBody = await first.text()
    expect(first.status).toBe(status)
    expect(originalBody).toBe(status === 204 ? '' : '{ "execution_id": "original-execution" }\n')
    // A successful response can reach the client before its bounded Redis write finishes.
    await waitForState(key)
    const retry = await send(method, path, key, body)
    expect(retry.status).toBe(status)
    expect(await retry.text()).toBe(originalBody)
    expect(retry.headers.get('content-type')).toBe(first.headers.get('content-type'))
    expect(retry.headers.get('location')).toBe(first.headers.get('location'))
    expect(runnerCalls).toBe(1)
  })
  it('shares the execution result between production MCP dispatch and a direct REST retry', async () => {
    const operation = new McpCatalog({
      box: parse(readFileSync(resolve(__dirname, '../../../../openapi/box.openapi.yaml'), 'utf8')),
      admin: {},
      dashboard: {},
      delegable: () => true,
      served: () => true,
    }).get('startExecution')!
    const boxId = randomUUID()
    const key = randomUUID()
    const body = { command: '/bin/echo', args: ['cross-transport'] }
    dispatcher = new McpDispatcher(app.get(HttpAdapterHost), new McpDelegation(), {} as BoxliteWsProxyService)
    const mcpRequest = { user: caller, headers: {}, socket: new Socket() } as unknown as Request
    const original = await dispatcher.call(operation, { box_id: boxId, 'Idempotency-Key': key, body }, mcpRequest)
    expect(original.status).toBe(201)
    expect(original.json).toEqual({ execution_id: 'original-execution' })
    await waitForState(key)
    const retry = await send('POST', `${boxId}/exec`, key, body)
    expect(retry.status).toBe(201)
    expect(await retry.json()).toEqual(original.json)
    expect(runnerCalls).toBe(1)
  })

  it('keeps a downstream failure behind the unknown fence', async () => {
    const status = 503
    reply = (_req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end('{"error":"downstream"}')
    }
    const key = randomUUID()
    const path = `${randomUUID()}/exec`
    const first = await send('POST', path, key, { command: 'effect' })
    expect(first.status).toBe(status)
    await first.text()
    await waitForState(key, ['unknown'])
    const retry = await send('POST', path, key, { command: 'effect' })
    expect(retry.status).toBe(422)
    expect(await retry.json()).toMatchObject({ code: 'idempotency_outcome_unknown' })
    expect(runnerCalls).toBe(1)
  })

  it('fences a runner disconnect after a partial success response', async () => {
    let upstream: ServerResponse | undefined
    reply = (_req, res) => {
      upstream = res
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.write('{"execution_id":')
    }
    const key = randomUUID()
    const path = `${randomUUID()}/exec`
    const body = { command: 'effect' }
    try {
      const first = await send('POST', path, key, body)
      expect(first.status).toBe(201)
      upstream?.destroy()
      await Promise.allSettled([first.text()])
      await waitForState(key, ['complete', 'unknown'])
      const retry = await send('POST', path, key, body)
      expect(retry.status).toBe(422)
      expect(await retry.json()).toMatchObject({ code: 'idempotency_outcome_unknown' })
      expect(runnerCalls).toBe(1)
    } finally {
      upstream?.destroy()
    }
  })

  it('rejects keyed file downloads before runner dispatch', async () => {
    const response = await send('GET', `${randomUUID()}/files?path=/tmp/file`, randomUUID())
    expect(response.status).toBe(400)
    await response.text()
    expect(boxService.findOneByIdOrName).not.toHaveBeenCalled()
    expect(autoResume.ensureReady).not.toHaveBeenCalled()
    expect(runnerCalls).toBe(0)
  })

  it('rejects keyed WebSockets for tenant organizations before effects', async () => {
    // Generic keys are covered by the WS service suite; this tenant resembles an API route prefix.
    const effect = jest.fn()
    const dependency = { getApiKeyByValue: effect, findOne: effect, consume: effect, createLog: effect }
    const service = new BoxliteWsProxyService(
      dependency as never,
      dependency as never,
      dependency as never,
      boxService as never,
      dependency as never,
      autoResume as never,
      dependency as never,
      undefined,
      dependency as never,
      dependency as never,
    )
    const socket = { write: jest.fn(), destroy: jest.fn() }
    const request = {
      url: `/api/v1/organizations/boxes/${randomUUID()}/executions/e1/attach?ticket=unused`,
      headers: { 'idempotency-key': randomUUID() },
    } as unknown as IncomingMessage
    await service.upgrade(request, socket as never, Buffer.alloc(0))
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('400 Bad Request'))
    expect(socket.destroy).toHaveBeenCalled()
    expect(effect).not.toHaveBeenCalled()
    expect(boxService.findOneByIdOrName).not.toHaveBeenCalled()
    expect(autoResume.ensureReady).not.toHaveBeenCalled()
    expect(runnerCalls).toBe(0)
  })
})
