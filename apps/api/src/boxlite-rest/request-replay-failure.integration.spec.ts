/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import { Body, Controller, INestApplication, Post, UsePipes } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import { IsString } from 'class-validator'
import Redis from 'ioredis'
import { randomUUID } from 'node:crypto'
import { BoxRequestReplayService } from './box-request-replay.service'
import { RequestReplayInterceptor } from './request-replay.interceptor'
import { ReplayValidationPipe } from '../common/replay-validation.pipe'
import { BoxliteVolumeController } from './boxlite-volume.controller'
import { VolumeService } from '../box/services/volume.service'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { BoxCreationLimitExceededError } from '../box/errors/box-creation-limit.error'

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
const describeRedis = process.env.REDIS_HOST ? describe : describe.skip

describeRedis('Classified failures at replay HTTP entry', () => {
  let redis: Redis
  let app: INestApplication
  let base: string
  const createVolume = jest.fn(async () => ({ id: randomUUID() }))
  beforeAll(async () => {
    redis = new Redis({ host: process.env.REDIS_HOST!, port: Number(process.env.REDIS_PORT || 6379) })
    const module = await Test.createTestingModule({
      controllers: [FailureController, BoxliteVolumeController],
      providers: [
        BoxRequestReplayService,
        { provide: getRedisConnectionToken(), useValue: redis },
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
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(OrganizationResourceActionGuard)
      .useValue({ canActivate: () => true })
      .compile()
    app = module.createNestApplication()
    app.setGlobalPrefix('api')
    app.use((req: { user: unknown }, _res: unknown, next: () => void) => {
      req.user = { organizationId: 'failure-org', organization: { id: 'failure-org' }, userId: 'u' }
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
  async function post(path: string, key: string, body: unknown = {}) {
    const res = await fetch(`${base}/api/v1/${path}`, {
      method: 'POST',
      headers: { 'idempotency-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() }
  }
  it('revalidates the same invalid input without turning it into unknown', async () => {
    const key = randomUUID()
    expect((await post('failure/validation', key, { value: 1 })).status).toBe(400)
    expect((await post('failure/validation', key, { value: 1 })).status).toBe(400)
  })
  it('preserves the four-step quota rejection, success, new rejection, original replay sequence', async () => {
    quota = true
    const key = randomUUID()
    expect((await post('failure/quota', key)).status).toBe(429)
    quota = false
    const original = await post('failure/quota', key)
    expect(original.status).toBe(201)
    quota = true
    expect((await post('failure/quota', randomUUID())).status).toBe(429)
    expect(await post('failure/quota', key)).toEqual(original)
    expect(created).toBe(1)
  })
  it('retains the fence after a volume was submitted but readiness failed', async () => {
    const key = randomUUID()
    const before = createVolume.mock.calls.length
    expect((await post('volumes', key)).status).toBe(500)
    expect((await post('volumes', key)).status).toBe(422)
    expect(createVolume.mock.calls.length - before).toBe(1)
  })
})
