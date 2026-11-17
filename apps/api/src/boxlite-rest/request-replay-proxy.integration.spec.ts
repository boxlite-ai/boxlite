/// <reference lib="es2024.promise" />
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { createHash, randomUUID } from 'node:crypto'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
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
  const runnerCalls: { method: string; path: string; body: string }[] = []
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
      let body = ''
      req.on('data', (chunk) => {
        body += chunk.toString()
      })
      req.on('end', () => {
        runnerCalls.push({ method: req.method!, path: req.url!, body })
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
    runnerCalls.length = 0
    jest.clearAllMocks()
    boxService.findOneByIdOrName.mockImplementation(async (id: string) => ({
      id,
      organizationId,
      runnerId: 'runner',
      autoResume: false,
      state: 'started',
      desiredState: 'started',
    }))
    reply = (req, res) => {
      if (req.url!.endsWith('/exec')) {
        res.writeHead(201, { 'Content-Type': 'application/json', Location: '/executions/original-execution' })
        res.end(JSON.stringify({ execution_id: 'original-execution' }))
      } else if (req.url!.includes('/ssh')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ enabled: !req.url!.endsWith('/ssh') || req.method !== 'DELETE', generation: 1 }))
      } else {
        res.writeHead(204)
        res.end()
      }
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

  async function waitForState(key: string, state = 'complete') {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      const hash = createHash('sha256').update(key).digest('hex')
      const keys = await redis.keys(`replay:${organizationId}:*:${hash}`)
      const states = await Promise.all(keys.map((record) => redis.hget(record, 'state')))
      if (states.includes(state)) return
      await delay(5)
    }
    throw new Error(`The proxy response did not reach replay state ${state}`)
  }

  it.each([
    ['POST', 'exec', 201, { command: '/bin/echo', args: ['hello'] }],
    ['POST', 'executions/e1/signal', 204, { signal: 'TERM' }],
    ['POST', 'executions/e1/resize', 204, { rows: 24, cols: 80 }],
    ['DELETE', 'executions/e1', 204, undefined],
    ['POST', 'ssh', 200, { listen_address: '0.0.0.0:2222', accounts: [{ login: 'alice' }] }],
    ['POST', 'ssh/enable', 200, undefined],
    ['DELETE', 'ssh', 200, undefined],
  ] as const)('replays %s %s status %s without another runner operation', async (method, suffix, status, body) => {
    const boxId = randomUUID()
    const key = randomUUID()
    const path = `${boxId}/${suffix}`
    const first = await send(method, path, key, body)
    const originalBody = await first.text()
    expect(first.status).toBe(status)
    // A successful response can reach the client before its bounded Redis write finishes.
    await waitForState(key)
    const retry = await send(method, path, key, body)
    expect(retry.status).toBe(status)
    expect(await retry.text()).toBe(originalBody)
    expect(retry.headers.get('content-type')).toBe(first.headers.get('content-type'))
    expect(retry.headers.get('location')).toBe(first.headers.get('location'))
    expect(runnerCalls).toHaveLength(1)
    expect(runnerCalls[0]).toMatchObject({ method, path: `/v1/boxes/${path}` })
    if (body !== undefined) expect(JSON.parse(runnerCalls[0].body)).toEqual(body)
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
    expect(runnerCalls).toHaveLength(1)
    await dispatcher.onModuleDestroy()
    dispatcher = undefined
  })

  it.each([400, 403, 500, 503])('keeps a runner %s behind the unknown fence', async (status) => {
    reply = (_req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end('{"error":"downstream"}')
    }
    const key = randomUUID()
    const path = `${randomUUID()}/exec`
    const first = await send('POST', path, key, { command: 'effect' })
    expect(first.status).toBe(status)
    await first.text()
    await waitForState(key, 'unknown')
    const retry = await send('POST', path, key, { command: 'effect' })
    expect(retry.status).toBe(422)
    expect(await retry.json()).toMatchObject({ code: 'idempotency_outcome_unknown' })
    expect(runnerCalls).toHaveLength(1)
  })

  it('permits the same key after proven admission refusal before auto-resume or dispatch', async () => {
    const key = randomUUID()
    const boxId = randomUUID()
    boxService.findOneByIdOrName.mockResolvedValueOnce({
      id: boxId,
      organizationId,
      runnerId: 'runner',
      autoResume: false,
      state: 'stopped',
      desiredState: 'stopped',
    })
    const first = await send('POST', `${boxId}/exec`, key, { command: 'effect' })
    expect(first.status).toBe(409)
    await first.text()
    expect(autoResume.ensureReady).not.toHaveBeenCalled()
    expect(runnerCalls).toHaveLength(0)
    const retry = await send('POST', `${boxId}/exec`, key, { command: 'effect' })
    expect(retry.status).toBe(201)
    await retry.text()
    expect(runnerCalls).toHaveLength(1)
  })

  it('fences auto-resume failures even when the original error is a readiness status', async () => {
    const key = randomUUID()
    const boxId = randomUUID()
    boxService.findOneByIdOrName.mockResolvedValueOnce({
      id: boxId,
      organizationId,
      runnerId: 'runner',
      autoResume: true,
      state: 'started',
      desiredState: 'started',
    })
    autoResume.ensureReady.mockRejectedValueOnce(new Error('start committed before wait failed') as never)
    const first = await send('POST', `${boxId}/exec`, key, { command: 'effect' })
    expect(first.status).toBe(500)
    await first.text()
    const retry = await send('POST', `${boxId}/exec`, key, { command: 'effect' })
    expect(retry.status).toBe(422)
    expect(autoResume.ensureReady).toHaveBeenCalledTimes(1)
    expect(runnerCalls).toHaveLength(0)
  })

  it('never dispatches again after a client disconnects during the runner response', async () => {
    const sent = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    reply = (_req, res) => {
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.write('{"execution_id":"original')
      sent.resolve()
      void release.promise.then(() => res.end('"}'))
    }
    const boxId = randomUUID()
    const key = randomUUID()
    const disconnected = Promise.withResolvers<void>()
    const client = httpRequest(
      `${base}/api/v1/boxes/${boxId}/exec`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': key, 'Content-Type': 'application/json' },
      },
      (res) => {
        res.once('data', () => {
          client.destroy()
          disconnected.resolve()
        })
      },
    )
    client.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') disconnected.reject(error)
    })
    client.end('{"command":"effect"}')
    await sent.promise
    await disconnected.promise
    await waitForState(key, 'unknown')
    const retry = await send('POST', `${boxId}/exec`, key, { command: 'effect' })
    expect(retry.status).toBe(422)
    expect(runnerCalls).toHaveLength(1)
    release.resolve()
  })

  it('records a delayed successful runner response after an overlapping retry was fenced', async () => {
    const sent = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    reply = (_req, res) => {
      sent.resolve()
      void release.promise.then(() => {
        res.writeHead(201, { 'Content-Type': 'application/json' })
        res.end('{"execution_id":"late-execution"}')
      })
    }
    const key = randomUUID()
    const path = `${randomUUID()}/exec`
    const original = send('POST', path, key, { command: 'effect' })
    await sent.promise
    const overlapping = await send('POST', path, key, { command: 'effect' })
    expect(overlapping.status).toBe(409)
    release.resolve()
    expect((await original).status).toBe(201)
    await waitForState(key)
    const retry = await send('POST', path, key, { command: 'effect' })
    expect(retry.status).toBe(201)
    expect(await retry.json()).toEqual({ execution_id: 'late-execution' })
    expect(runnerCalls).toHaveLength(1)
  })
})
