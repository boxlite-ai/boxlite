/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import { BoxRequestReplayService } from './box-request-replay.service'

const describeIfRedis = process.env.REDIS_HOST ? describe : describe.skip

describeIfRedis('BoxRequestReplayService (real Redis)', () => {
  let redis: Redis
  let service: BoxRequestReplayService
  const org = 'org-replay-test'
  const user = 'user-1'

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
    service = new BoxRequestReplayService(redis)
  })

  afterAll(async () => {
    service.onModuleDestroy()
    await redis.quit()
  })

  const cleanup = async (...keys: string[]) => {
    if (keys.length) await redis.del(...keys)
  }

  const keyOf = (operation: string, requestId: string) =>
    `replay:${org}:${user}:${operation}:${require('crypto').createHash('sha256').update(requestId).digest('hex')}`

  it('returns a no-op session when no key is provided', async () => {
    const session = await service.session(org, user, 'createBox', undefined, 'fp-empty')
    expect(session.response).toBeUndefined()
    expect(session.isOwner).toBe(false)
    await session.complete({ status: 201, body: '{}' })
    await session.markRetryable()
  })

  it('lets a new key owner proceed and a same-key same-fingerprint caller replay', async () => {
    const key = randomUUID()
    const fp = 'fp-alpine'
    const first = await service.session(org, user, 'createBox', key, fp)
    expect(first.isOwner).toBe(true)
    expect(first.response).toBeUndefined()

    const response = { status: 201, body: JSON.stringify({ box_id: 'box-1' }) }
    await first.complete(response)

    const second = await service.session(org, user, 'createBox', key, fp)
    expect(second.isOwner).toBe(false)
    expect(second.response).toEqual(response)
    await cleanup(keyOf('createBox', key))
  })

  it('rejects a same-key different-fingerprint caller with 422', async () => {
    const key = randomUUID()
    const fpA = 'fp-alpine'
    const fpB = 'fp-debian'
    const first = await service.session(org, user, 'createBox', key, fpA)
    expect(first.isOwner).toBe(true)

    await expect(service.session(org, user, 'createBox', key, fpB)).rejects.toMatchObject({
      status: 422,
      response: expect.objectContaining({ code: 'idempotency_payload_mismatch' }),
    })
    await cleanup(keyOf('createBox', key))
  })

  // A pending record whose completion deadline has passed reports an unknown
  // outcome: the caller must not redispatch on a maybe-executed request.
  it('reports unknown and blocks redispatch once the completion deadline passes', async () => {
    const key = randomUUID()
    const fp = 'fp-empty'
    const first = await service.session(org, user, 'createBox', key, fp)
    expect(first.isOwner).toBe(true)
    await redis.hset(keyOf('createBox', key), 'expected_response_at', '1')

    await expect(service.session(org, user, 'createBox', key, fp)).rejects.toMatchObject({
      status: 422,
      response: expect.objectContaining({ code: 'idempotency_outcome_unknown' }),
    })
    await cleanup(keyOf('createBox', key))
  })

  // A corrupt stored body is unusable: replaying it would send garbage, and
  // deleting it would re-dispatch, so the conservative unknown applies.
  it('treats a corrupt stored response as unknown', async () => {
    const key = randomUUID()
    const fp = 'fp-empty'
    const first = await service.session(org, user, 'createBox', key, fp)
    expect(first.isOwner).toBe(true)
    await redis.hset(keyOf('createBox', key), 'response', 'not-json{')

    await expect(service.session(org, user, 'createBox', key, fp)).rejects.toMatchObject({
      status: 422,
      response: expect.objectContaining({ code: 'idempotency_outcome_unknown' }),
    })
    await cleanup(keyOf('createBox', key))
  })

  it('blocks a concurrent same-key caller with 409 while the owner is pending', async () => {
    const key = randomUUID()
    const fp = 'fp-empty'
    const first = await service.session(org, user, 'createBox', key, fp)
    expect(first.isOwner).toBe(true)

    await expect(service.session(org, user, 'createBox', key, fp)).rejects.toMatchObject({ status: 409 })

    await first.complete({ status: 201, body: '{}' })
    await cleanup(keyOf('createBox', key))
  })

  it('allows a same-key caller to reclaim a record released after a safe quota failure', async () => {
    const key = randomUUID()
    const fp = 'fp-empty'
    const first = await service.session(org, user, 'createBox', key, fp)
    expect(first.isOwner).toBe(true)
    await first.markRetryable()

    const second = await service.session(org, user, 'createBox', key, fp)
    expect(second.isOwner).toBe(true)
    expect(second.response).toBeUndefined()
    await second.complete({ status: 201, body: '{}' })

    const third = await service.session(org, user, 'createBox', key, fp)
    expect(third.response).toEqual({ status: 201, body: '{}' })
    await cleanup(keyOf('createBox', key))
  })

  it('rejects a stale owner writing after a newer caller reclaimed the key', async () => {
    const key = randomUUID()
    const fp = 'fp-empty'
    const first = await service.session(org, user, 'createBox', key, fp)
    await first.markRetryable()

    const second = await service.session(org, user, 'createBox', key, fp)
    expect(second.isOwner).toBe(true)

    // The first session's fencing token is stale; its complete is rejected.
    const before = await redis.hgetall(keyOf('createBox', key))
    expect(before['state']).toBe('pending')
    expect(before['owner']).not.toBe('')

    await second.complete({ status: 201, body: '{}' })
    await first.complete({ status: 201, body: '{"box_id":"stale"}' })
    const after = await redis.hgetall(keyOf('createBox', key))
    expect(after['state']).toBe('complete')
    expect(after['response']).toBe(JSON.stringify({ status: 201, body: '{}' }))
    await cleanup(keyOf('createBox', key))
  })

  it('stores distinct records for different operations with the same key', async () => {
    const key = randomUUID()
    const fp = 'fp-empty'
    const create = await service.session(org, user, 'createBox', key, fp)
    const exec = await service.session(org, user, 'startExecution', key, fp)
    expect(create.isOwner).toBe(true)
    expect(exec.isOwner).toBe(true)
    await create.complete({ status: 201, body: '{"box_id":"b1"}' })
    await exec.complete({ status: 201, body: '{"execution_id":"e1"}' })

    const createReplay = await service.session(org, user, 'createBox', key, fp)
    const execReplay = await service.session(org, user, 'startExecution', key, fp)
    expect(createReplay.response).toEqual({ status: 201, body: '{"box_id":"b1"}' })
    expect(execReplay.response).toEqual({ status: 201, body: '{"execution_id":"e1"}' })
    await cleanup(keyOf('createBox', key), keyOf('startExecution', key))
  })

  it('isolates records across organizations for the same key', async () => {
    const key = randomUUID()
    const fp = 'fp-empty'
    const orgA = await service.session('org-a', user, 'createBox', key, fp)
    const orgB = await service.session('org-b', user, 'createBox', key, fp)
    expect(orgA.isOwner).toBe(true)
    expect(orgB.isOwner).toBe(true)
    await cleanup(
      `replay:org-a:${user}:createBox:${require('crypto').createHash('sha256').update(key).digest('hex')}`,
      `replay:org-b:${user}:createBox:${require('crypto').createHash('sha256').update(key).digest('hex')}`,
    )
  })
})
