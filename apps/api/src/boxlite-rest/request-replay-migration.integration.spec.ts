/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import { Body, Controller, INestApplication, Post, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import Redis from 'ioredis'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import ts from 'typescript'
import { BoxRequestReplayService } from './box-request-replay.service'
import { RequestReplayInterceptor } from './request-replay.interceptor'
import { CreateBoxDto } from './dto/create-box.dto'

@Controller('v1')
class MigrationController {
  @Post('boxes') create(@Body() body: unknown) {
    return { box_id: randomUUID(), body }
  }
  @Post('boxes/:boxId/exec') exec() {
    return { execution_id: randomUUID() }
  }
}
interface LegacySession {
  complete(value: { status: number; body: string }): Promise<void>
  releaseSafe(value: boolean): Promise<void>
}
interface LegacyEngine {
  session(org: string, user: string, op: string, key: string, fp: string): Promise<LegacySession>
}
const describeRedis = process.env.REDIS_HOST ? describe : describe.skip

describeRedis('Existing #2760 replay record migration', () => {
  let app: INestApplication
  let redis: Redis
  let base: string
  let legacy: LegacyEngine
  let legacyFingerprint: (method: string, path: string, body: unknown) => string
  const org = 'migration-org'
  // Execute the actual original producer, not a second test implementation of its Lua/DTO contract.
  beforeAll(async () => {
    const source = execFileSync(
      'git',
      ['show', '0eed749b014e5bce112c7e0047915e4ba7da2933:apps/api/src/boxlite-rest/box-request-replay.service.ts'],
      { encoding: 'utf8' },
    )
    const js = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true },
    }).outputText
    // This compiler output comes from the pinned repository producer with these exported signatures.
    const original: {
      exports: {
        BoxRequestReplayService: new (redis: Redis) => LegacyEngine
        fingerprintOf: (method: string, path: string, body: unknown) => string
      }
    } = { exports: {} as never }
    new Function('require', 'module', 'exports', js)(require, original, original.exports)
    redis = new Redis({ host: process.env.REDIS_HOST!, port: Number(process.env.REDIS_PORT || 6379) })
    legacy = new original.exports.BoxRequestReplayService(redis)
    legacyFingerprint = original.exports.fingerprintOf
    const module = await Test.createTestingModule({
      controllers: [MigrationController],
      providers: [BoxRequestReplayService, { provide: getRedisConnectionToken(), useValue: redis }],
    }).compile()
    app = module.createNestApplication()
    app.setGlobalPrefix('api')
    app.use((req: { user: unknown }, _res: unknown, next: () => void) => {
      req.user = { organizationId: org, userId: 'u' }
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
  const keyOf = (operation: string, key: string) =>
    `replay:${org}:u:${operation}:${createHash('sha256').update(key).digest('hex')}`
  async function post(path: string, key: string, body: unknown) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() }
  }
  it.each(['createBox', 'startExecution'])(
    'replays old completed %s response and keeps its original expiry',
    async (operation) => {
      const key = randomUUID()
      const body = { image: 'boxlite/base' }
      const path = operation === 'createBox' ? '/api/v1/boxes' : '/api/v1/boxes/b/exec'
      const dto =
        operation === 'createBox'
          ? await new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }).transform(body, {
              type: 'body',
              metatype: CreateBoxDto,
            })
          : body
      const session = await legacy.session(
        org,
        'u',
        operation,
        key,
        legacyFingerprint('POST', operation === 'createBox' ? '/boxes' : path, dto),
      )
      const original = operation === 'createBox' ? { box_id: 'original-box' } : { execution_id: 'original-exec' }
      await session.complete({ status: 201, body: JSON.stringify(original) })
      const ttl = await redis.pttl(keyOf(operation, key))
      expect(await post(path, key, body)).toEqual({ status: 201, body: original })
      expect(await redis.pttl(keyOf(operation, key))).toBeLessThanOrEqual(ttl)
      expect((await post(path, key, { image: 'changed' })).status).toBe(422)
    },
  )
  it('keeps a missing-state old pending fence and allows only proven retryable reclaim', async () => {
    const body = { command: 'echo hi' }
    const path = '/api/v1/boxes/b/exec'
    const fp = legacyFingerprint('POST', path, body)
    const pending = randomUUID()
    await legacy.session(org, 'u', 'startExecution', pending, fp)
    expect((await post(path, pending, body)).status).toBe(409)
    await redis.hset(keyOf('startExecution', pending), 'expected_response_at', '1')
    expect((await post(path, pending, body)).status).toBe(422)
    const retryable = randomUUID()
    const session = await legacy.session(org, 'u', 'startExecution', retryable, fp)
    await session.releaseSafe(true)
    expect((await post(path, retryable, body)).status).toBe(201)
  })
})
