/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import {
  ClassSerializerInterceptor,
  Controller,
  HttpCode,
  INestApplication,
  Post,
  Res,
  UseInterceptors,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import { Exclude } from 'class-transformer'
import type { Request, Response } from 'express'
import Redis from 'ioredis'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { BoxRequestReplayService, REPLAY_MAX_RESPONSE_BYTES } from './box-request-replay.service'
import { RequestReplayInterceptor } from './request-replay.interceptor'

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
    res.status(201).setHeader('location', '/resource/original')
    res.setHeader('set-cookie', 'first-cookie=secret')
    res.setHeader('x-original-only', 'first')
    res.json({ id: randomUUID() })
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
const describeRedis = process.env.REDIS_HOST ? describe : describe.skip

describeRedis('Replay serialized HTTP response boundary', () => {
  let app: INestApplication
  let redis: Redis
  let base: string
  const org = 'response-org'
  beforeAll(async () => {
    redis = new Redis({ host: process.env.REDIS_HOST!, port: Number(process.env.REDIS_PORT || 6379) })
    const module = await Test.createTestingModule({
      controllers: [ResponseController],
      providers: [BoxRequestReplayService, Reflector, { provide: getRedisConnectionToken(), useValue: redis }],
    }).compile()
    app = module.createNestApplication()
    app.setGlobalPrefix('api')
    app.use((req: Request & { user: unknown }, res: Response, next: () => void) => {
      req.user = { organizationId: org, userId: 'u' }
      res.setHeader('x-request-id', randomUUID())
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
  async function post(path: string, key: string) {
    const res = await fetch(`${base}/api/v1/responses/${path}`, { method: 'POST', headers: { 'idempotency-key': key } })
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
