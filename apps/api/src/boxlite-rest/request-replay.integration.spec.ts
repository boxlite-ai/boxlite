/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { createHash, randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import http from 'node:http'
import { connect, createServer, type Server, type Socket } from 'node:net'
import Redis from 'ioredis'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import {
  BadRequestException,
  Body,
  ClassSerializerInterceptor,
  Controller,
  HttpCode,
  INestApplication,
  Post,
  Req,
  Res,
  Type,
  UseInterceptors,
  UsePipes,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test, TestingModule } from '@nestjs/testing'
import { Exclude } from 'class-transformer'
import { IsString } from 'class-validator'
import type { Request, Response } from 'express'
import { BoxRequestReplayService, REPLAY_MAX_RESPONSE_BYTES } from './box-request-replay.service'
import { RequestReplayInterceptor } from './request-replay.interceptor'
import { ReplayValidationPipe } from '../common/replay-validation.pipe'
import { BoxliteBoxController } from './boxlite-box.controller'
import { BoxliteVolumeController } from './boxlite-volume.controller'
import { BoxService } from '../box/services/box.service'
import { BoxStateWaiterService } from '../box/services/box-state-waiter.service'
import { VolumeService } from '../box/services/volume.service'
import { CommerceBoxLimitService } from './commerce-box-limit.service'
import { CheckpointRecoverService } from '../box/services/checkpoint-recover.service'
import { BoxCreationLimitExceededError } from '../box/errors/box-creation-limit.error'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'

let executions = 0
@Controller('v1/replay-probe')
class UnmarkedWriteController {
  @Post()
  create(@Body() body: unknown) {
    return { id: ++executions, body }
  }
}

@Controller(['v1/identity/:target', 'v1/:prefix/identity/:target'])
class IdentityController {
  @Post()
  create(@Body() body: unknown, @Req() req: Request) {
    return { id: randomUUID(), body, target: req.params.target }
  }
}

class PublicResult {
  readonly id = randomUUID()
  @Exclude() secret = 'server-private'
}
@Controller('v1/responses')
class ResponseController {
  @Post('dto')
  @UseInterceptors(ClassSerializerInterceptor)
  dto() {
    return new PublicResult()
  }
  @Post('empty')
  @HttpCode(204)
  empty() {}
  @Post('location')
  location(@Res() res: Response) {
    res.status(201).header('location', `/api/v1/things/${randomUUID()}`).json({ created: true })
  }
  @Post('chunked')
  async chunked(@Res() res: Response) {
    res.type('application/json')
    await new Promise<void>((resolve, reject) => {
      res.write('{"id":', (error) => (error ? reject(error) : resolve()))
    })
    const payload = JSON.stringify(randomUUID()) + ',"large":"' + 'x'.repeat(32768) + '"}'
    if (!res.write(payload)) await once(res, 'drain')
    res.end()
  }
  @Post('oversized')
  oversized(@Res() res: Response) {
    res.type('application/json').end(JSON.stringify({ value: 'x'.repeat(REPLAY_MAX_RESPONSE_BYTES) }))
  }
}

let effects = 0
@Controller('v1/storage')
class StorageController {
  @Post() create(@Body() _body: unknown) {
    return { id: ++effects }
  }
}

class Input {
  @IsString() value!: string
}
let quota = true
let created = 0
@Controller('v1/failure')
@UsePipes(new ReplayValidationPipe({ transform: true }))
class FailureController {
  @Post('validation') input(@Body() body: Input) {
    return body
  }
  @Post('quota') quota() {
    if (quota) throw new BoxCreationLimitExceededError(3, 3)
    return { id: ++created }
  }
}

let release: () => void
let entered: () => void
let gate: Promise<void>
@Controller('v1/concurrency')
class SlowController {
  @Post() async create() {
    entered()
    await gate
    return { id: randomUUID() }
  }
}

/** TCP fault boundary; Redis, its Lua scripts and command deadlines remain production implementations. */
class RedisGate {
  readonly sockets = new Set<Socket>()
  readonly server: Server
  mode: 'open' | 'reserve' | 'complete' = 'open'
  port = 0
  constructor() {
    this.server = createServer((client) => {
      const upstream = connect({ host: process.env.REDIS_HOST!, port: Number(process.env.REDIS_PORT || 6379) })
      this.sockets.add(client)
      this.sockets.add(upstream)
      client.on('error', () => undefined)
      upstream.on('error', () => client.destroy())
      upstream.pipe(client)
      let dropping = false
      client.on('data', (chunk) => {
        const text = chunk.toString()
        if (
          (this.mode === 'reserve' && text.includes('local fp =')) ||
          (this.mode === 'complete' && text.includes('local state =') && text.includes("'complete'"))
        )
          dropping = true
        if (!dropping) upstream.write(chunk)
      })
      client.once('close', () => {
        upstream.destroy()
        this.sockets.delete(client)
        this.sockets.delete(upstream)
      })
    })
  }
  async open() {
    this.server.listen(0, '127.0.0.1')
    await once(this.server, 'listening')
    const addr = this.server.address()
    if (!addr || typeof addr === 'string') throw new Error('TCP listener unavailable')
    this.port = addr.port
  }
  async close() {
    for (const socket of this.sockets) socket.destroy()
    if (this.server.listening) await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

type ReplayMiddleware = (req: Request & { user: unknown }, res: Response, next: () => void) => void

const describeIfRedis = process.env.REDIS_HOST ? describe : describe.skip
const passThrough = { canActivate: () => true }

async function connectRedis() {
  const redis = new Redis({
    host: process.env.REDIS_HOST!,
    port: Number(process.env.REDIS_PORT || 6379),
    username: process.env.REDIS_USERNAME || undefined,
    password: process.env.REDIS_PASSWORD || undefined,
    lazyConnect: true,
    connectTimeout: 2_000,
    maxRetriesPerRequest: 1,
    retryStrategy: null,
  })
  await redis.connect()
  return redis
}

async function closeRedis(redis?: Redis) {
  if (redis?.status === 'ready') await redis.quit()
}

function userMiddleware(user: unknown): ReplayMiddleware {
  return (req, _res, next) => {
    req.user = user
    next()
  }
}

/** One shared local HTTP setup: pass-through auth guards, per-suite caller middleware, global replay interceptor. */
async function replayServer(options: {
  redis: Redis
  controllers: Type<unknown>[]
  providers?: { provide: unknown; useValue: unknown }[]
  middleware?: ReplayMiddleware
}): Promise<{ app: INestApplication; base: string; module: TestingModule }> {
  const module = await Test.createTestingModule({
    controllers: options.controllers,
    providers: [
      BoxRequestReplayService,
      { provide: getRedisConnectionToken(), useValue: options.redis },
      ...(options.providers ?? []),
    ] as never,
  })
    .overrideGuard(CombinedAuthGuard)
    .useValue(passThrough)
    .overrideGuard(OrganizationResourceActionGuard)
    .useValue(passThrough)
    .compile()
  const app = module.createNestApplication()
  app.setGlobalPrefix('api')
  if (options.middleware) app.use(options.middleware)
  app.useGlobalInterceptors(new RequestReplayInterceptor(module.get(BoxRequestReplayService)))
  await app.listen(0, '127.0.0.1')
  return { app, base: await app.getUrl(), module }
}

async function postJson(
  base: string,
  path: string,
  options: { key?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.key !== undefined ? { 'idempotency-key': options.key } : {}),
      ...options.headers,
    },
    body: JSON.stringify(options.body ?? {}),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describeIfRedis('Unified request replay HTTP (real Redis)', () => {
  describe('default entry fencing', () => {
    let app: INestApplication
    let redis: Redis
    let base: string
    const caller = { organizationId: 'replay-entry', organization: { id: 'replay-entry' }, userId: 'user' }
    const create = jest.fn(async () => ({ id: randomUUID(), state: 'starting' }))
    const waitForStarted = jest.fn(async () => {
      throw new BadRequestException('submitted operation rejected later')
    })

    beforeAll(async () => {
      redis = await connectRedis()
      const started = await replayServer({
        redis,
        controllers: [UnmarkedWriteController, BoxliteBoxController],
        providers: [
          { provide: BoxService, useValue: { create } },
          { provide: BoxStateWaiterService, useValue: { waitForStarted } },
          { provide: CommerceBoxLimitService, useValue: { resolveMaxCreatedBoxes: async () => 3 } },
          { provide: CheckpointRecoverService, useValue: {} },
        ],
        middleware: userMiddleware(caller),
      })
      app = started.app
      base = started.base
    })
    afterAll(async () => {
      await app?.close()
      await closeRedis(redis)
    })

    const post = (path: string, key?: string, body: unknown = { value: 'same' }) =>
      postJson(base, `/api/v1/${path}`, { key, body })

    it('automatically fences a new unmarked write route', async () => {
      const key = randomUUID()
      const first = await post('replay-probe', key)
      const retry = await post('replay-probe', key)
      expect(first.status).toBe(201)
      expect(retry).toEqual(first)
    })

    it('allows identical writes without a key to execute independently', async () => {
      const first = await post('replay-probe')
      const second = await post('replay-probe')
      expect(Number(second.body.id)).toBe(Number(first.body.id) + 1)
    })

    it('does not redispatch a Box submitted before a later 400', async () => {
      const before = create.mock.calls.length
      const key = randomUUID()
      const first = await post('boxes', key, { image: 'boxlite/base' })
      const retry = await post('boxes', key, { image: 'boxlite/base' })
      expect(first.status).toBe(400)
      expect(retry.status).toBe(422)
      expect(create.mock.calls.length - before).toBe(1)
    })
  })

  describe('request identity', () => {
    let app: INestApplication
    let redis: Redis
    let base: string
    beforeAll(async () => {
      redis = await connectRedis()
      const started = await replayServer({
        redis,
        controllers: [IdentityController],
        middleware: (req, _res, next) => {
          req.user = { userId: req.headers['x-user'] ?? 'u', organizationId: req.headers['x-org'] ?? 'identity-org' }
          next()
        },
      })
      app = started.app
      base = started.base
    })
    afterAll(async () => {
      await app.close()
      await closeRedis(redis)
    })
    const post = (key: string, body: unknown, path = '/identity/target', headers: Record<string, string> = {}) =>
      postJson(base, `/api/v1${path}`, { key, body, headers })
    it('replays nested object reorder and canonical organization alias', async () => {
      const key = randomUUID()
      const first = await post(key, { nested: { z: 1, a: [null, false] }, a: 1 })
      const retry = await post(key, { a: 1, nested: { a: [null, false], z: 1 } }, '/identity-org/identity/target')
      expect(first.status).toBe(201)
      expect(retry).toEqual(first)
      expect((await post(key, { a: 1 }, '/other-org/identity/target')).status).toBe(403)
    })
    it.each([
      [{ a: [1, 2] }, { a: [2, 1] }, '/identity/target'],
      [{ a: null }, {}, '/identity/target'],
      [{ a: false }, { a: 0 }, '/identity/target'],
      [{ a: 1 }, { a: 1 }, '/identity/other'],
      [{ a: 1 }, { a: 1 }, '/identity/target?force=true'],
      [{ a: 1 }, { a: 1 }, '/identity/target?q=a&q=b'],
    ])('rejects changed body or target/query %j => %j %s', async (before, after, path) => {
      const key = randomUUID()
      expect((await post(key, before)).status).toBe(201)
      expect((await post(key, after, path as string)).status).toBe(422)
    })
    it('isolates users and organizations sharing a UUID', async () => {
      const key = randomUUID()
      const first = await post(key, {})
      const user = await post(key, {}, undefined, { 'x-user': 'other' })
      const org = await post(key, {}, undefined, { 'x-org': 'other' })
      expect(user.status).toBe(201)
      expect(org.status).toBe(201)
      expect(user.body.id).not.toBe(first.body.id)
      expect(org.body.id).not.toBe(first.body.id)
    })
    it.each(['', 'not-a-uuid'])('rejects invalid UUID header %j before execution', async (key) => {
      expect((await post(key, {})).status).toBe(400)
    })
    it('rejects repeated raw header fields', async () => {
      const key = randomUUID()
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          `${base}/api/v1/identity/target`,
          {
            method: 'POST',
            headers: ['Idempotency-Key', key, 'Idempotency-Key', key, 'Content-Type', 'application/json'],
          },
          (res) => {
            res.resume()
            res.once('end', () => resolve(res.statusCode!))
          },
        )
        req.on('error', reject)
        req.end('{}')
      })
      expect(status).toBe(400)
    })
  })

  describe('serialized response boundary', () => {
    let app: INestApplication
    let redis: Redis
    let base: string
    const org = 'response-org'
    beforeAll(async () => {
      redis = await connectRedis()
      const started = await replayServer({
        redis,
        controllers: [ResponseController],
        providers: [{ provide: Reflector, useValue: new Reflector() }],
        middleware: (req, res, next) => {
          req.user = { organizationId: org, userId: 'u' }
          res.setHeader('x-request-id', randomUUID())
          next()
        },
      })
      app = started.app
      base = started.base
    })
    afterAll(async () => {
      await app.close()
      await closeRedis(redis)
    })
    async function post(path: string, key: string) {
      const res = await fetch(`${base}/api/v1/responses/${path}`, {
        method: 'POST',
        headers: { 'idempotency-key': key },
      })
      return { status: res.status, body: await res.text(), headers: res.headers }
    }
    async function completed(key: string) {
      const suffix = createHash('sha256').update(key).digest('hex')
      const deadline = Date.now() + 3000
      do {
        const keys = await redis.keys(`replay:${org}:u:*:${suffix}`)
        if (keys.length && (await redis.hget(keys[0], 'state')) === 'complete') return
        await new Promise<void>((resolve) => setImmediate(resolve))
      } while (Date.now() < deadline)
      throw new Error('response not recorded')
    }
    it.each(['dto', 'empty', 'location', 'chunked'])(
      'replays original %s bytes and retains only permitted headers',
      async (path) => {
        const key = randomUUID()
        const first = await post(path, key)
        await completed(key)
        const retry = await post(path, key)
        expect(retry.status).toBe(first.status)
        expect(retry.body).toBe(first.body)
        expect(retry.headers.get('content-type')).toBe(first.headers.get('content-type'))
        expect(retry.headers.get('location')).toBe(first.headers.get('location'))
        expect(retry.headers.get('x-request-id')).not.toBe(first.headers.get('x-request-id'))
        expect(retry.headers.get('set-cookie')).toBeNull()
        expect(retry.headers.get('x-original-only')).toBeNull()
        if (path === 'dto') expect(retry.body).not.toContain('secret')
        if (path === 'empty') {
          expect(retry.status).toBe(204)
          expect(retry.body).toBe('')
        }
      },
    )
    it('forwards oversized success but retains an unknown fence', async () => {
      const key = randomUUID()
      const first = await post('oversized', key)
      expect(first.status).toBe(201)
      expect(first.body.length).toBeGreaterThan(REPLAY_MAX_RESPONSE_BYTES)
      const retry = await post('oversized', key)
      expect(retry.status).toBe(422)
    })
  })

  describe('storage faults and retention', () => {
    let redis: Redis
    let gate: RedisGate
    let app: INestApplication
    let base: string
    let client: Redis
    let engine: BoxRequestReplayService
    const org = 'storage-org'
    const record = (key: string) =>
      `replay:${org}:u:POST /api/v1/storage:${createHash('sha256').update(key).digest('hex')}`
    beforeEach(async () => {
      gate = new RedisGate()
      await gate.open()
      redis = await connectRedis()
      client = new Redis({ host: '127.0.0.1', port: gate.port, lazyConnect: true, retryStrategy: null })
      const started = await replayServer({
        redis: client,
        controllers: [StorageController],
        middleware: userMiddleware({ organizationId: org, userId: 'u' }),
      })
      engine = started.module.get(BoxRequestReplayService)
      app = started.app
      base = started.base
    })
    afterEach(async () => {
      await app?.close()
      client?.disconnect()
      await gate?.close()
      await closeRedis(redis)
    })
    const post = (key?: string) => postJson(base, '/api/v1/storage', { key })
    it('bounds stalled reservations before dispatch while no-key traffic stays independent', async () => {
      gate.mode = 'reserve'
      const before = effects
      const started = Date.now()
      expect((await post(randomUUID())).status).toBe(503)
      expect(Date.now() - started).toBeLessThan(1800)
      expect(effects).toBe(before)
      expect((await post()).status).toBe(201)
      expect(effects).toBe(before + 1)
    })
    it('delivers success without waiting for stalled completion and keeps its fence', async () => {
      gate.mode = 'complete'
      const key = randomUUID()
      const before = effects
      const started = Date.now()
      expect((await post(key)).status).toBe(201)
      expect(Date.now() - started).toBeLessThan(900)
      const direct = new BoxRequestReplayService(redis)
      const fingerprint = await redis.hget(record(key), 'fingerprint')
      if (!fingerprint) throw new Error('Reservation fingerprint missing')
      try {
        await expect(direct.session(org, 'u', 'POST /api/v1/storage', key, fingerprint)).rejects.toMatchObject({
          status: 409,
        })
      } finally {
        direct.onModuleDestroy()
      }
      expect(effects).toBe(before + 1)
      expect(await redis.exists(record(key))).toBe(1)
    })
    it('keeps absolute TTL through unknown, late owner success and same-key replay, then expires', async () => {
      const key = randomUUID()
      const fp = 'v2:retention'
      const operation = 'POST /api/v1/storage'
      const owner = await engine.session(org, 'u', operation, key, fp)
      const ttl = await redis.pttl(record(key))
      await owner.markUnknown()
      await owner.heartbeat()
      await expect(engine.session(org, 'u', operation, key, fp)).rejects.toMatchObject({ status: 422 })
      await owner.complete({ status: 201, body: '{"id":"original"}' })
      expect((await engine.session(org, 'u', operation, key, fp)).response?.body).toBe('{"id":"original"}')
      expect(await redis.pttl(record(key))).toBeLessThanOrEqual(ttl)
      await redis.pexpire(record(key), 1)
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
      expect((await engine.session(org, 'u', operation, key, fp)).isOwner).toBe(true)
    })
    it('rejects new reservations at noeviction capacity without losing existing fences', async () => {
      // Isolate maxmemory to another Redis process, never mutate the shared integration server.
      // CI runners expose a Redis service without the server binary; there the case skips and
      // the contract stays established by the connection-backed cases around it.
      if (spawnSync('redis-server', ['--version'], { encoding: 'utf8' }).status !== 0) {
        console.warn('Skipping the noeviction capacity case: redis-server binary is unavailable')
        return
      }
      const port = gate.port
      await gate.close()
      const process = spawn(
        'redis-server',
        [
          '--bind',
          '127.0.0.1',
          '--port',
          String(port),
          '--save',
          '',
          '--appendonly',
          'no',
          '--maxmemory-policy',
          'noeviction',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      const ready = new Promise<void>((resolve, reject) => {
        process.stdout.on('data', (chunk) => {
          if (chunk.toString().includes('Ready to accept connections')) resolve()
        })
        process.once('error', reject)
      })
      await ready
      const isolated = new Redis({ host: '127.0.0.1', port })
      const service = new BoxRequestReplayService(isolated)
      try {
        const key = randomUUID()
        const pending = await service.session(org, 'u', 'capacity', key, 'v2:capacity')
        expect(pending.isOwner).toBe(true)
        await isolated.config('SET', 'maxmemory', '1')
        await expect(service.session(org, 'u', 'capacity', randomUUID(), 'v2:other')).rejects.toMatchObject({
          status: 503,
        })
        await expect(service.session(org, 'u', 'capacity', key, 'v2:capacity')).rejects.toMatchObject({ status: 409 })
      } finally {
        service.onModuleDestroy()
        await isolated.quit()
        const exited = once(process, 'exit')
        process.kill()
        await exited
      }
      // afterEach may close an already-closed TCP gate safely.
    })
  })

  describe('classified failures at the entry', () => {
    let redis: Redis
    let app: INestApplication
    let base: string
    const createVolume = jest.fn(async () => ({ id: randomUUID() }))
    beforeAll(async () => {
      redis = await connectRedis()
      const started = await replayServer({
        redis,
        controllers: [FailureController, BoxliteVolumeController],
        providers: [
          {
            provide: VolumeService,
            useValue: {
              create: createVolume,
              waitForReady: async () => {
                throw new Error('submitted volume never ready')
              },
            },
          },
        ],
        middleware: userMiddleware({
          organizationId: 'failure-org',
          organization: { id: 'failure-org' },
          userId: 'u',
        }),
      })
      app = started.app
      base = started.base
    })
    afterAll(async () => {
      await app.close()
      await closeRedis(redis)
    })
    const post = (path: string, key: string, body: unknown = {}) => postJson(base, `/api/v1/${path}`, { key, body })
    it('revalidates the same invalid input without turning it into unknown', async () => {
      const key = randomUUID()
      expect((await post('failure/validation', key, { value: 1 })).status).toBe(400)
      expect((await post('failure/validation', key, { value: 1 })).status).toBe(400)
    })
    it('retains the fence after a volume was submitted but readiness failed', async () => {
      const key = randomUUID()
      const before = createVolume.mock.calls.length
      expect((await post('volumes', key)).status).toBe(500)
      expect((await post('volumes', key)).status).toBe(422)
      expect(createVolume.mock.calls.length - before).toBe(1)
    })
  })

  describe('cross-replica create dispatch', () => {
    let redis: Redis
    let appA: INestApplication
    let appB: INestApplication
    let baseA: string
    let baseB: string
    let callsA = { value: 0 }
    let callsB = { value: 0 }
    const createMocks = new Map<string, jest.Mock>()
    const org = 'org-replay-itest'
    const caller = { organizationId: org, organization: { id: org }, userId: 'user-replay' }
    const startedBox = {
      id: 'replay-box-1',
      organizationId: org,
      name: 'replay-box-1',
      state: 'started',
      image: 'boxlite/base',
      cpu: 1,
      memory: 1,
      labels: {},
    }

    async function startReplica(calls: { value: number }) {
      const create = jest.fn(async () => {
        calls.value++
        return startedBox
      })
      const started = await replayServer({
        redis,
        controllers: [BoxliteBoxController],
        providers: [
          {
            provide: BoxService,
            useValue: {
              create,
              findOneByIdOrName: jest.fn().mockResolvedValue(startedBox),
              toBoxDto: jest.fn().mockResolvedValue(startedBox),
            },
          },
          { provide: BoxStateWaiterService, useValue: {} },
          { provide: CommerceBoxLimitService, useValue: { resolveMaxCreatedBoxes: async () => 3 } },
          { provide: CheckpointRecoverService, useValue: {} },
        ],
        middleware: userMiddleware(caller),
      })
      createMocks.set(calls === callsA ? 'a' : 'b', create)
      return started
    }

    beforeAll(async () => {
      redis = await connectRedis()
      const a = await startReplica(callsA)
      const b = await startReplica(callsB)
      appA = a.app
      baseA = a.base
      appB = b.app
      baseB = b.base
    })
    afterAll(async () => {
      await appA?.close()
      await appB?.close()
      await closeRedis(redis)
    })

    const post = (base: string, path: string, key: string | undefined, body: unknown) =>
      postJson(base, path, { key, body })

    it('one of two concurrent same-key replicas creates; the loser gets 409 and its retry replays', async () => {
      const key = randomUUID()
      const body = { image: 'boxlite/base' }

      // Hold the winning create open so both reservations definitely overlap:
      // without this, the mock resolves immediately and the second request may
      // arrive after the record completes, making both 201.
      // (Manual executor: the project's TS lib predates Promise.withResolvers.)
      let releaseCreate!: () => void
      const createGate = new Promise<void>((resolve) => {
        releaseCreate = resolve
      })
      const createA = createMocks.get('a')!
      createA.mockImplementationOnce(async () => {
        callsA.value++
        await createGate
        return startedBox
      })

      const ownerPromise = post(baseA, '/api/v1/boxes', key, body)
      // Wait until replica A owns the key (exact record key, same formula as
      // the service), then let replica B race for it. Bounded so a regression
      // fails with a clear message instead of eating the suite timeout.
      const digest = createHash('sha256').update(key).digest('hex')
      const recordKey = `replay:${org}:${caller.userId}:createBox:${digest}`
      const deadline = Date.now() + 3000
      while (!(await redis.exists(recordKey))) {
        if (Date.now() > deadline) throw new Error(`record ${recordKey} never appeared`)
        await new Promise((r) => setTimeout(r, 10))
      }
      try {
        // The loser's 409 arrives while the owner's create is still held open:
        // deterministic overlap, no reliance on Promise.all scheduling.
        const loser = await post(baseB, '/api/v1/boxes', key, body)
        releaseCreate()
        const owner = await ownerPromise

        // Exactly one replica dispatched the create.
        expect(callsA.value + callsB.value).toBe(1)
        expect(loser.status).toBe(409)
        expect(owner.status).toBe(201)

        // The loser retries with the same key and now gets the stored success.
        const retryBase = owner.status === 201 ? baseB : baseA
        const retry = await post(retryBase, '/api/v1/boxes', key, body)
        expect(retry.status).toBe(201)
        expect(retry.body).toEqual(owner.body)
        expect(callsA.value + callsB.value).toBe(1)
      } catch (error) {
        // Release the held create even on failure, so afterAll can close appA.
        releaseCreate()
        throw error
      }
      await ownerPromise.catch(() => undefined)
    }, 15_000)

    it('releases a quota rejection for a safe retry and replays the original success at full quota', async () => {
      const key = randomUUID()
      const body = { image: 'boxlite/base' }
      const createA = createMocks.get('a')!
      const beforeA = callsA.value

      // Step 1: quota rejection with the key on replica A is classified retryable.
      createA.mockRejectedValueOnce(new BoxCreationLimitExceededError(3, 3))
      expect((await post(baseA, '/api/v1/boxes', key, body)).status).toBe(429)

      // Step 2: the same key on replica B now succeeds; a new box is created.
      const succeeded = await post(baseB, '/api/v1/boxes', key, body)
      expect(succeeded.status).toBe(201)
      expect(succeeded.body.box_id).toBe(startedBox.id)

      // Step 3: a fresh key at full quota is rejected again and does not disturb the stored record.
      createA.mockRejectedValueOnce(new BoxCreationLimitExceededError(3, 3))
      expect((await post(baseA, '/api/v1/boxes', randomUUID(), body)).status).toBe(429)

      // Step 4: the original key replays the stored success without another create.
      const beforeB = callsB.value
      const replayed = await post(baseA, '/api/v1/boxes', key, body)
      expect(replayed.status).toBe(201)
      expect(replayed.body).toEqual(succeeded.body)
      expect(callsB.value).toBe(beforeB)
      expect(callsA.value).toBe(beforeA)
    })
  })

  describe('active owner across API replicas', () => {
    let redis: Redis
    const apps: INestApplication[] = []
    const bases: string[] = []
    beforeAll(async () => {
      redis = await connectRedis()
      for (let i = 0; i < 2; i++) {
        const started = await replayServer({
          redis,
          controllers: [SlowController],
          middleware: userMiddleware({ organizationId: 'concurrency-org', userId: 'u' }),
        })
        apps.push(started.app)
        bases.push(started.base)
      }
    })
    afterAll(async () => {
      release?.()
      for (const app of apps) await app.close()
      await closeRedis(redis)
    })
    const post = (base: string, key: string) => postJson(base, '/api/v1/concurrency', { key })
    it('keeps a slow live owner pending beyond the original five-second deadline without extending retention', async () => {
      let onEntered!: () => void
      const started = new Promise<void>((resolve) => {
        onEntered = resolve
      })
      entered = onEntered
      gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const key = randomUUID()
      const owner = post(bases[0], key)
      await started
      const record = `replay:concurrency-org:u:POST /api/v1/concurrency:${createHash('sha256').update(key).digest('hex')}`
      const initialTtl = await redis.pttl(record)
      try {
        const competitor = await post(bases[1], key)
        expect(competitor.status).toBe(409)
        expect(competitor.body.code).toBe('idempotency_in_progress')
        await new Promise<void>((resolve) => setTimeout(resolve, 5500))
        const slowRetry = await post(bases[1], key)
        expect(slowRetry.status).toBe(409)
        expect(await redis.pttl(record)).toBeLessThan(initialTtl - 5000)
        release()
        const original = await owner
        expect(original.status).toBe(201)
        const deadline = Date.now() + 3000
        while ((await redis.hget(record, 'state')) !== 'complete') {
          if (Date.now() > deadline) throw new Error('late success missing')
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
        expect(await post(bases[1], key)).toEqual(original)
      } finally {
        release()
        await owner
      }
    }, 15000)
  })
})
