/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import { BadRequestException, Body, Controller, INestApplication, Post } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { BoxRequestReplayService } from './box-request-replay.service'
import { BoxliteBoxController } from './boxlite-box.controller'
import { BoxService } from '../box/services/box.service'
import { BoxStateWaiterService } from '../box/services/box-state-waiter.service'
import { CommerceBoxLimitService } from './commerce-box-limit.service'
import { CheckpointRecoverService } from '../box/services/checkpoint-recover.service'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { RequestReplayInterceptor } from './request-replay.interceptor'

let executions = 0
@Controller('v1/replay-probe')
class UnmarkedWriteController {
  @Post()
  create(@Body() body: unknown) {
    return { id: ++executions, body }
  }
}

const describeRedis = process.env.REDIS_HOST ? describe : describe.skip
describeRedis('Default request replay HTTP entry', () => {
  let app: INestApplication
  let redis: Redis
  let base: string
  const caller = { organizationId: 'replay-entry', organization: { id: 'replay-entry' }, userId: 'user' }
  const create = jest.fn(async () => ({ id: randomUUID(), state: 'starting' }))
  const waitForStarted = jest.fn(async () => {
    throw new BadRequestException('submitted operation rejected later')
  })

  beforeAll(async () => {
    redis = new Redis({ host: process.env.REDIS_HOST!, port: Number(process.env.REDIS_PORT || 6379) })
    const module = await Test.createTestingModule({
      controllers: [UnmarkedWriteController, BoxliteBoxController],
      providers: [
        BoxRequestReplayService,
        { provide: getRedisConnectionToken(), useValue: redis },
        { provide: BoxService, useValue: { create } },
        { provide: BoxStateWaiterService, useValue: { waitForStarted } },
        { provide: CommerceBoxLimitService, useValue: { resolveMaxCreatedBoxes: async () => 3 } },
        { provide: CheckpointRecoverService, useValue: {} },
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
      req.user = caller
      next()
    })
    app.useGlobalInterceptors(new RequestReplayInterceptor(module.get(BoxRequestReplayService)))
    await app.listen(0, '127.0.0.1')
    base = await app.getUrl()
  })
  afterAll(async () => {
    await app?.close()
    await redis?.quit()
  })

  async function post(path: string, key?: string, body: unknown = { value: 'same' }) {
    const response = await fetch(`${base}/api/v1/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }

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
    expect(second.body.id).toBe(first.body.id + 1)
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
