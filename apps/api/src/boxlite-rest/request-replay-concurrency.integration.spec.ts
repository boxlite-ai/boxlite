/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import { Controller, INestApplication, Post } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import Redis from 'ioredis'
import { createHash, randomUUID } from 'node:crypto'
import { BoxRequestReplayService } from './box-request-replay.service'
import { RequestReplayInterceptor } from './request-replay.interceptor'

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
const describeRedis = process.env.REDIS_HOST ? describe : describe.skip

describeRedis('Active owner across API replicas', () => {
  let redis: Redis
  const apps: INestApplication[] = []
  const bases: string[] = []
  beforeAll(async () => {
    redis = new Redis({ host: process.env.REDIS_HOST!, port: Number(process.env.REDIS_PORT || 6379) })
    for (let i = 0; i < 2; i++) {
      const module = await Test.createTestingModule({
        controllers: [SlowController],
        providers: [BoxRequestReplayService, { provide: getRedisConnectionToken(), useValue: redis }],
      }).compile()
      const app = module.createNestApplication()
      app.setGlobalPrefix('api')
      app.use((req: { user: unknown }, _res: unknown, next: () => void) => {
        req.user = { organizationId: 'concurrency-org', userId: 'u' }
        next()
      })
      app.useGlobalInterceptors(new RequestReplayInterceptor(module.get(BoxRequestReplayService)))
      await app.listen(0, '127.0.0.1')
      apps.push(app)
      bases.push(await app.getUrl())
    }
  })
  afterAll(async () => {
    release?.()
    for (const app of apps) await app.close()
    await redis.quit()
  })
  async function post(base: string, key: string) {
    const res = await fetch(`${base}/api/v1/concurrency`, { method: 'POST', headers: { 'idempotency-key': key } })
    return { status: res.status, body: await res.json() }
  }
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
