/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { BoxliteBoxController } from './boxlite-box.controller'
import { BoxRequestReplayService } from './box-request-replay.service'
import { BoxService } from '../box/services/box.service'
import { BoxStateWaiterService } from '../box/services/box-state-waiter.service'
import { CommerceBoxLimitService } from './commerce-box-limit.service'
import { CheckpointRecoverService } from '../box/services/checkpoint-recover.service'
import { BoxCreationLimitExceededError } from '../box/errors/box-creation-limit.error'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'

/** Tracks create calls across both replica applications. */
function createCounter() {
  return { value: 0 }
}

/**
 * Two API instances sharing one Redis: the first wins the key and succeeds;
 * the second (a replica or a retried request) replays the stored response
 * without calling the business layer again. Proves cross-instance atomicity
 * through the real Lua scripts, not a mock.
 */
const describeIfRedis = process.env.REDIS_HOST ? describe : describe.skip

describeIfRedis('Box request replay real Redis HTTP', () => {
  let redis: Redis
  let appA: INestApplication
  let appB: INestApplication
  let baseA: string
  let baseB: string
  let callsA = createCounter()
  let callsB = createCounter()
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

  async function startApp(calls: {
    value: number
  }): Promise<{ app: INestApplication; base: string; create: jest.Mock }> {
    const create = jest.fn(async () => {
      calls.value++
      return startedBox
    })
    const boxService = {
      create,
      findOneByIdOrName: jest.fn().mockResolvedValue(startedBox),
      toBoxDto: jest.fn().mockResolvedValue(startedBox),
    }
    const module = await Test.createTestingModule({
      controllers: [BoxliteBoxController],
      providers: [
        BoxRequestReplayService,
        { provide: getRedisConnectionToken(), useValue: redis },
        { provide: BoxService, useValue: boxService },
        { provide: BoxStateWaiterService, useValue: {} },
        { provide: CommerceBoxLimitService, useValue: { resolveMaxCreatedBoxes: async () => 3 } },
        { provide: CheckpointRecoverService, useValue: {} },
      ],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(OrganizationResourceActionGuard)
      .useValue({
        canActivate: (ctx: { switchToHttp: () => { getRequest: () => { user: unknown } } }) => {
          ctx.switchToHttp().getRequest().user = caller
          return true
        },
      })
      .compile()
    const app = module.createNestApplication()
    app.setGlobalPrefix('api')
    await app.listen(0, '127.0.0.1')
    return { app, base: await app.getUrl(), create }
  }

  beforeAll(async () => {
    redis = new Redis({
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
    const a = await startApp(callsA)
    const b = await startApp(callsB)
    appA = a.app
    baseA = a.base
    appB = b.app
    baseB = b.base
    createMocks.set('a', a.create)
    createMocks.set('b', b.create)
  })

  const createMocks = new Map<string, jest.Mock>()

  afterAll(async () => {
    await appA?.close()
    await appB?.close()
    if (redis?.status === 'ready') await redis.quit()
  })

  async function post(base: string, path: string, key: string | undefined, body: unknown) {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (key) headers['idempotency-key'] = key
    const response = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }

  it('one of two concurrent same-key replicas creates; the loser gets 409 and its retry replays', async () => {
    const key = randomUUID()
    const body = { image: 'boxlite/base' }

    const [first, second] = await Promise.all([
      post(baseA, '/api/v1/boxes', key, body),
      post(baseB, '/api/v1/boxes', key, body),
    ])

    // Exactly one replica dispatches the create; the other is told to retry.
    const totalCalls = callsA.value + callsB.value
    expect(totalCalls).toBe(1)
    const statuses = [first.status, second.status]
    expect(statuses).toContain(201)
    expect(statuses).toContain(409)

    // The loser retries with the same key and now gets the stored success.
    const winner = first.status === 201 ? first : second
    const retryBase = first.status === 201 ? baseB : baseA
    const retry = await post(retryBase, '/api/v1/boxes', key, body)
    expect(retry.status).toBe(201)
    expect(retry.body).toEqual(winner.body)
    expect(callsA.value + callsB.value).toBe(1)
  })

  it('rejects a same-key different-payload caller with 422 across replicas', async () => {
    const key = randomUUID()
    const first = await post(baseA, '/api/v1/boxes', key, { image: 'boxlite/base' })
    expect(first.status).toBe(201)

    const mismatch = await post(baseB, '/api/v1/boxes', key, { image: 'debian' })
    expect(mismatch.status).toBe(422)
    expect(mismatch.body).toMatchObject({ code: 'idempotency_payload_mismatch' })
  })

  it('allows a same-key retry to succeed after a quota rejection released the slot', async () => {
    const key = randomUUID()
    const body = { image: 'boxlite/base' }

    // Step 1: quota rejection with the key on replica A.
    const createA = createMocks.get('a')!
    createA.mockRejectedValueOnce(new BoxCreationLimitExceededError(3, 3))
    const rejected = await post(baseA, '/api/v1/boxes', key, body)
    expect(rejected.status).toBe(429)

    // Step 2: same key on replica B now succeeds; a new box is created.
    const succeeded = await post(baseB, '/api/v1/boxes', key, body)
    expect(succeeded.status).toBe(201)
    expect(succeeded.body.box_id).toBe(startedBox.id)

    // Step 3: same key on replica A replays the stored success without a create call.
    const beforeB = callsB.value
    const replayed = await post(baseA, '/api/v1/boxes', key, body)
    expect(replayed.status).toBe(201)
    expect(replayed.body).toEqual(succeeded.body)
    expect(callsB.value).toBe(beforeB)
  })
})
