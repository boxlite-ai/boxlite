/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import { Body, Controller, INestApplication, Post, Req } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import Redis from 'ioredis'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import type { Request } from 'express'
import { BoxRequestReplayService } from './box-request-replay.service'
import { RequestReplayInterceptor } from './request-replay.interceptor'

@Controller(['v1/identity/:target', 'v1/:prefix/identity/:target'])
class IdentityController {
  @Post()
  create(@Body() body: unknown, @Req() req: Request) {
    return { id: randomUUID(), body, target: req.params.target }
  }
}
const describeRedis = process.env.REDIS_HOST ? describe : describe.skip

describeRedis('Replay HTTP request identity', () => {
  let app: INestApplication
  let redis: Redis
  let base: string
  beforeAll(async () => {
    redis = new Redis({ host: process.env.REDIS_HOST!, port: Number(process.env.REDIS_PORT || 6379) })
    const module = await Test.createTestingModule({
      controllers: [IdentityController],
      providers: [BoxRequestReplayService, { provide: getRedisConnectionToken(), useValue: redis }],
    }).compile()
    app = module.createNestApplication()
    app.setGlobalPrefix('api')
    app.use((req: Request & { user: unknown }, _res: unknown, next: () => void) => {
      req.user = { userId: req.headers['x-user'] ?? 'u', organizationId: req.headers['x-org'] ?? 'identity-org' }
      next()
    })
    app.useGlobalInterceptors(new RequestReplayInterceptor(module.get(BoxRequestReplayService)))
    await app.listen(0, '127.0.0.1')
    base = await app.getUrl()
  })
  afterAll(async () => {
    await app.close()
    await redis.quit()
  })
  async function post(key: string, body: unknown, path = '/identity/target', headers: Record<string, string> = {}) {
    const response = await fetch(`${base}/api/v1${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key, ...headers },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }
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
