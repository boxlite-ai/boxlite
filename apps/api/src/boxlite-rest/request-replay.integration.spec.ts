/// <reference lib="es2024.promise" />
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { request as httpRequest } from 'node:http'
import Redis from 'ioredis'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import {
  BadRequestException,
  Body,
  ClassSerializerInterceptor,
  Controller,
  HttpCode,
  INestApplication,
  Param,
  Post,
  Res,
  UseInterceptors,
  UsePipes,
} from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { Exclude } from 'class-transformer'
import { IsString } from 'class-validator'
import type { Request, Response, NextFunction } from 'express'
import { BoxRequestReplayService, REPLAY_MAX_RESPONSE_BYTES } from './box-request-replay.service'
import { RequestReplayInterceptor } from './request-replay.interceptor'
import { ReplayParseIntPipe, ReplayValidationPipe } from '../common/replay-validation.pipe'
import { BoxCreationLimitExceededError } from '../box/errors/box-creation-limit.error'
import { Audit } from '../audit/decorators/audit.decorator'
import { AuditAction } from '../audit/enums/audit-action.enum'
import { AuditTarget } from '../audit/enums/audit-target.enum'
import { AuditInterceptor } from '../audit/interceptors/audit.interceptor'
import { AuditService } from '../audit/services/audit.service'

class Input {
  @IsString() value!: string
}
class PublicResult {
  readonly id = randomUUID()
  @Exclude() secret = 'private'
}
let effects = 0
let quota = false
let entered = Promise.withResolvers<void>()
let release = Promise.withResolvers<void>()
@Controller(['v1/probe/:target', 'v1/:prefix/probe/:target'])
class ProbeController {
  @Post()
  create(@Body() body: unknown) {
    return { id: ++effects, body }
  }
  @Post('slow')
  async slow() {
    effects++
    entered.resolve()
    await release.promise
    return { id: randomUUID() }
  }
  @Post('quota')
  admitted() {
    if (quota) throw new BoxCreationLimitExceededError(3, 3)
    return this.create({})
  }
  @Post('failure')
  submitted() {
    effects++
    throw new BadRequestException('effect committed before failure')
  }
  @Post('validate')
  @UsePipes(new ReplayValidationPipe({ transform: true }))
  validate(@Body() body: Input) {
    return this.create(body)
  }
  @Post('count/:count')
  count(@Param('count', ReplayParseIntPipe) count: number) {
    return this.create({ count })
  }
  @Post('dto')
  @Audit({ action: AuditAction.CREATE, targetType: AuditTarget.BOX, targetIdFromResult: (result) => result.id })
  @UseInterceptors(ClassSerializerInterceptor)
  dto() {
    effects++
    return new PublicResult()
  }
  @Post('empty')
  @HttpCode(204)
  empty() {
    effects++
  }
  @Post('large')
  large(@Res() res: Response) {
    effects++
    res.json({ value: 'x'.repeat(REPLAY_MAX_RESPONSE_BYTES) })
  }
}

@Controller('v1/boxes')
class VolumeWriteController {
  @Post()
  create() {
    return { id: ++effects }
  }
}

const integration = process.env.REDIS_HOST ? describe : describe.skip
integration('Replay HTTP contract with shared Redis', () => {
  const org = randomUUID()
  const apps: INestApplication[] = []
  const bases: string[] = []
  let redis: Redis
  const services: BoxRequestReplayService[] = []
  const audit = {
    createLog: jest.fn(async () => ({ id: randomUUID() })),
    updateLog: jest.fn(async () => undefined),
  }
  beforeAll(async () => {
    redis = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT || 6379),
      username: process.env.REDIS_USERNAME || undefined,
      password: process.env.REDIS_PASSWORD || undefined,
    })
    await redis.ping()
    for (let i = 0; i < 2; i++) {
      const module = await Test.createTestingModule({
        controllers: [ProbeController, VolumeWriteController],
        providers: [
          AuditInterceptor,
          BoxRequestReplayService,
          { provide: getRedisConnectionToken(), useValue: redis },
          { provide: AuditService, useValue: audit },
        ],
      }).compile()
      services.push(module.get(BoxRequestReplayService))
      const app = module.createNestApplication()
      app.setGlobalPrefix('api')
      app.use((req: Request & { user?: unknown }, res: Response, next: NextFunction) => {
        req.user = {
          organizationId: req.headers['x-org'] ?? org,
          userId: req.headers['x-user'] ?? 'user',
          role: 'user',
        }
        res.setHeader('x-request-id', randomUUID())
        next()
      })
      app.useGlobalInterceptors(
        app.get(AuditInterceptor),
        new RequestReplayInterceptor(module.get(BoxRequestReplayService)),
      )
      await app.listen(0, '127.0.0.1')
      apps.push(app)
      bases.push(await app.getUrl())
    }
  })
  afterAll(async () => {
    release.resolve()
    for (const app of apps) await app.close()
    if (redis) {
      const keys = await redis.keys(`replay:${org}:*`)
      if (keys.length) await redis.del(...keys)
      await redis.quit()
    }
  })
  const send = async (
    key?: string,
    path = 'probe/target',
    body: unknown = {},
    replica = 0,
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(`${bases[replica]}/api/v1/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key === undefined ? {} : { 'Idempotency-Key': key }),
        ...headers,
      },
      body: JSON.stringify(body),
    })
    return { status: response.status, text: await response.text(), headers: response.headers }
  }
  async function completed(key: string) {
    const digest = createHash('sha256').update(key).digest('hex')
    const deadline = Date.now() + 3000
    do {
      const keys = await redis.keys(`replay:${org}:*:${digest}`)
      if (keys.length && (await redis.hget(keys[0], 'state')) === 'complete') return
      await delay(5)
    } while (Date.now() < deadline)
    throw new Error('Response persistence did not complete')
  }

  it('replays canonical input across aliases and rejects changed input without another effect', async () => {
    const key = randomUUID()
    const before = effects
    const original = await send(key, 'probe/target', { b: 2, a: [1, null] })
    expect(original.status).toBe(201)
    await completed(key)
    const retry = await send(key, `${org}/probe/target`, { a: [1, null], b: 2 }, 1)
    expect(retry.text).toBe(original.text)
    expect(retry.headers.get('x-request-id')).not.toBe(original.headers.get('x-request-id'))
    for (const [path, body] of [
      ['probe/other', { b: 2, a: [1, null] }],
      ['probe/target?force=true', { b: 2, a: [1, null] }],
      ['probe/target', { b: 2, a: [null, 1] }],
    ] as const)
      expect((await send(key, path, body)).status).toBe(422)
    expect(effects).toBe(before + 1)
    expect((await send(key, 'probe/target', {}, 0, { 'x-user': 'other' })).status).toBe(201)
    expect((await send(key, 'foreign/probe/target')).status).toBe(403)
  })

  it('passes unkeyed writes through and rejects malformed keys before effects', async () => {
    const before = effects
    expect((await send()).status).toBe(201)
    expect((await send()).status).toBe(201)
    for (const key of ['', 'invalid', `${randomUUID()}, ${randomUUID()}`]) {
      expect((await send(key)).status).toBe(400)
    }
    expect(effects).toBe(before + 2)
  })

  it('rejects unauthenticated callers, unauthorized volumes and non-JSON keyed bodies before effects', async () => {
    const before = effects
    expect((await send(randomUUID(), 'probe/target', {}, 0, { 'x-user': '' })).status).toBe(403)
    expect((await send(randomUUID(), 'boxes', { volumes: [{ id: 'private-volume' }] })).status).toBe(403)
    const response = await fetch(`${bases[0]}/api/v1/probe/target`, {
      method: 'POST',
      headers: { 'Idempotency-Key': randomUUID(), 'Content-Type': 'text/plain' },
      body: 'opaque',
    })
    expect(response.status).toBe(400)
    expect(effects).toBe(before)
  })

  it('keeps a disconnected owner fenced until its late response is recorded', async () => {
    entered = Promise.withResolvers<void>()
    release = Promise.withResolvers<void>()
    const key = randomUUID()
    const request = httpRequest(`${bases[0]}/api/v1/probe/target/slow`, {
      method: 'POST',
      headers: { 'Idempotency-Key': key, 'Content-Type': 'application/json' },
    })
    request.on('error', () => undefined)
    request.end('{}')
    await entered.promise
    try {
      request.destroy()
      const deadline = Date.now() + 3000
      while ((await send(key, 'probe/target/slow', {}, 1)).status !== 422) {
        if (Date.now() >= deadline) throw new Error('Disconnected owner was not fenced')
        await delay(5)
      }
      release.resolve()
      await completed(key)
      expect((await send(key, 'probe/target/slow', {}, 1)).status).toBe(201)
    } finally {
      request.destroy()
      release.resolve()
    }
  })

  it('preserves the fence when recording an error fails', async () => {
    const original = services[0].session.bind(services[0])
    const spy = jest.spyOn(services[0], 'session').mockImplementationOnce(async (...args) => {
      const owner = await original(...args)
      jest.spyOn(owner, 'markUnknown').mockRejectedValueOnce(new Error('Redis unavailable'))
      return owner
    })
    const key = randomUUID()
    try {
      expect((await send(key, 'probe/target/failure')).status).toBe(400)
      expect((await send(key, 'probe/target/failure')).status).toBe(409)
    } finally {
      spy.mockRestore()
    }
  })

  it('rejects malformed numeric input without fencing a later identical attempt', async () => {
    const key = randomUUID()
    const before = effects
    expect((await send(key, 'probe/target/count/invalid')).status).toBe(400)
    expect((await send(key, 'probe/target/count/invalid')).status).toBe(400)
    expect((await send(randomUUID(), 'probe/target/count/3')).status).toBe(201)
    expect(effects).toBe(before + 1)
  })

  it('holds one owner across replicas and records its late success', async () => {
    entered = Promise.withResolvers<void>()
    release = Promise.withResolvers<void>()
    const key = randomUUID()
    const before = effects
    const owner = send(key, 'probe/target/slow')
    await entered.promise
    try {
      expect((await send(key, 'probe/target/slow', {}, 1)).status).toBe(409)
      const hash = createHash('sha256').update(key).digest('hex')
      const [record] = await redis.keys(`replay:${org}:*:${hash}`)
      const initial = await redis.hget(record, 'expected_response_at')
      const deadline = Date.now() + 3000
      while ((await redis.hget(record, 'expected_response_at')) === initial) {
        if (Date.now() >= deadline) throw new Error('Owner heartbeat did not renew its deadline')
        await delay(10)
      }
      expect((await send(key, 'probe/target/slow', {}, 1)).status).toBe(409)
      release.resolve()
      const original = await owner
      await completed(key)
      expect((await send(key, 'probe/target/slow', {}, 1)).text).toBe(original.text)
      expect(effects).toBe(before + 1)
    } finally {
      release.resolve()
      await owner
    }
  })

  it('allows proven admission rejection to retry but fences a post-effect 400', async () => {
    const key = randomUUID()
    quota = true
    expect((await send(key, 'probe/target/quota')).status).toBe(429)
    quota = false
    expect((await send(key, 'probe/target/quota')).status).toBe(201)
    await completed(key)
    quota = true
    expect((await send(key, 'probe/target/quota')).status).toBe(201)
    quota = false
    const failedKey = randomUUID()
    const before = effects
    expect((await send(failedKey, 'probe/target/failure')).status).toBe(400)
    expect((await send(failedKey, 'probe/target/failure')).status).toBe(422)
    expect(effects).toBe(before + 1)
    const invalid = randomUUID()
    expect((await send(invalid, 'probe/target/validate', { value: 1 })).status).toBe(400)
    expect((await send(invalid, 'probe/target/validate', { value: 1 })).status).toBe(400)
  })

  it.each(['dto', 'empty'])('preserves serialized %s responses', async (suffix) => {
    const key = randomUUID()
    const before = effects
    const original = await send(key, `probe/target/${suffix}`)
    expect(original.status).toBe(suffix === 'empty' ? 204 : 201)
    await completed(key)
    const retry = await send(key, `probe/target/${suffix}`, {}, 1)
    expect(retry.status).toBe(original.status)
    expect(retry.text).toBe(original.text)
    expect(retry.text).not.toContain('secret')
    expect(effects).toBe(before + 1)
  })

  it('audits the same created resource on a replay from another replica', async () => {
    audit.createLog.mockClear()
    audit.updateLog.mockClear()
    const key = randomUUID()
    const original = await send(key, 'probe/target/dto')
    expect(original.status).toBe(201)
    const { id } = JSON.parse(original.text)
    expect(id).toEqual(expect.any(String))
    await completed(key)
    const retry = await send(key, 'probe/target/dto', {}, 1)
    expect(retry.status).toBe(201)
    const [first, replay] = audit.createLog.mock.results
    expect(audit.updateLog.mock.calls).toEqual([
      [(await first.value).id, expect.objectContaining({ targetId: id }), expect.any(Number)],
      [(await replay.value).id, expect.objectContaining({ targetId: id }), expect.any(Number)],
    ])
  })

  it('forwards an oversized success while keeping its unknown fence', async () => {
    const key = randomUUID()
    const before = effects
    const first = await send(key, 'probe/target/large')
    expect(first.status).toBe(201)
    expect(first.text.length).toBeGreaterThan(REPLAY_MAX_RESPONSE_BYTES)
    expect((await send(key, 'probe/target/large')).status).toBe(422)
    expect(effects).toBe(before + 1)
  })
})
