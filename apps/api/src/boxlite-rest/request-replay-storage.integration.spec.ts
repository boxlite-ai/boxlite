/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import { Body, Controller, INestApplication, Post } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import Redis from 'ioredis'
import { createHash, randomUUID } from 'node:crypto'
import { createServer, connect, Socket, Server } from 'node:net'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { BoxRequestReplayService } from './box-request-replay.service'
import { RequestReplayInterceptor } from './request-replay.interceptor'

let effects = 0
@Controller('v1/storage')
class StorageController {
  @Post() create(@Body() _body: unknown) {
    return { id: ++effects }
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
const describeRedis = process.env.REDIS_HOST ? describe : describe.skip

describeRedis('Replay storage faults and retention', () => {
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
    redis = new Redis({ host: process.env.REDIS_HOST!, port: Number(process.env.REDIS_PORT || 6379) })
    client = new Redis({ host: '127.0.0.1', port: gate.port, lazyConnect: true, retryStrategy: null })
    const module = await Test.createTestingModule({
      controllers: [StorageController],
      providers: [BoxRequestReplayService, { provide: getRedisConnectionToken(), useValue: client }],
    }).compile()
    engine = module.get(BoxRequestReplayService)
    app = module.createNestApplication()
    app.setGlobalPrefix('api')
    app.use((req: { user: unknown }, _res: unknown, next: () => void) => {
      req.user = { organizationId: org, userId: 'u' }
      next()
    })
    app.useGlobalInterceptors(new RequestReplayInterceptor(engine))
    await app.listen(0, '127.0.0.1')
    base = await app.getUrl()
  })
  afterEach(async () => {
    await app?.close()
    client?.disconnect()
    await gate?.close()
    await redis?.quit()
  })
  async function post(key?: string) {
    const response = await fetch(`${base}/api/v1/storage`, {
      method: 'POST',
      headers: key ? { 'idempotency-key': key } : {},
    })
    return { status: response.status, body: await response.json() }
  }
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
