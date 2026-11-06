/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import { Logger } from '@nestjs/common'
import Redis from 'ioredis'
import { LockCode, RedisLockProvider } from '../common/redis-lock.provider'
import { BoxActivityService } from './box-activity.service'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const describeWithRedis = process.env.REDIS_HOST ? describe : describe.skip

describeWithRedis('Activity throttle cancellation with real Redis', () => {
  let redis: Redis
  let provider: RedisLockProvider
  let service: BoxActivityService
  let boxId: string
  let lockKey: string

  beforeAll(async () => {
    redis = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT || 6379),
      maxRetriesPerRequest: 0,
    })
    await redis.ping()
  })
  beforeEach(() => {
    boxId = `activity-throttle-${randomUUID()}`
    lockKey = `box:update-last-activity:${boxId}`
    provider = new RedisLockProvider(redis)
    service = new BoxActivityService(redis, {} as never, provider, { getOrThrow: () => 30 } as never)
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await redis.del(lockKey)
    await redis.zrem('box:activity', boxId)
  })
  afterAll(async () => {
    await redis?.quit()
  })

  function pauseAcquisition() {
    const acquired = deferred()
    const resume = deferred()
    const acquire = provider.lock.bind(provider)
    jest.spyOn(provider, 'lock').mockImplementationOnce(async (...args) => {
      const locked = await acquire(...args)
      acquired.resolve()
      await resume.promise
      return locked
    })
    return { acquired: acquired.promise, resume: resume.resolve }
  }

  it('releases a late acquired throttle so the next heartbeat is recorded', async () => {
    const pause = pauseAcquisition()
    const abort = new AbortController()
    const reason = new Error('preview expired')
    const rejected = expect(service.updateLastActivityAt(boxId, new Date(1), abort.signal)).rejects.toBe(reason)
    await pause.acquired
    abort.abort(reason)
    pause.resume()
    await rejected

    expect(await redis.get(lockKey)).toBeNull()
    const at = new Date('2026-11-07T00:00:00Z')
    await service.updateLastActivityAt(boxId, at)
    expect(await redis.zscore('box:activity', boxId)).toBe(String(at.getTime()))
  })

  it('does not delete an owner that replaced the expired cancelled lock', async () => {
    const pause = pauseAcquisition()
    const abort = new AbortController()
    const reason = new Error('preview expired')
    const rejected = expect(service.updateLastActivityAt(boxId, new Date(1), abort.signal)).rejects.toBe(reason)
    await pause.acquired
    await redis.pexpire(lockKey, 0)
    expect(await provider.lock(lockKey, 30, new LockCode('replacement-owner'))).toBe(true)
    abort.abort(reason)
    pause.resume()
    await rejected

    expect(await redis.get(lockKey)).toBe('replacement-owner')
    expect(await redis.zscore('box:activity', boxId)).toBeNull()
  })

  it('preserves the abort reason if owner cleanup rejects', async () => {
    const pause = pauseAcquisition()
    const abort = new AbortController()
    const reason = new Error('preview expired')
    const cleanup = jest.spyOn(provider, 'releaseLease').mockRejectedValueOnce(new Error('private-redis-error'))
    const rejected = expect(service.updateLastActivityAt(boxId, new Date(1), abort.signal)).rejects.toBe(reason)
    await pause.acquired
    abort.abort(reason)
    pause.resume()
    await rejected

    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(Logger.prototype.warn).toHaveBeenCalledWith('Could not release cancelled activity throttle', { boxId })
    expect(JSON.stringify(jest.mocked(Logger.prototype.warn).mock.calls)).not.toContain('private-redis-error')
  })

  it('never releases an existing throttle when acquisition fails after abort', async () => {
    await redis.set(lockKey, 'existing-owner', 'EX', 30)
    const pause = pauseAcquisition()
    const abort = new AbortController()
    const cleanup = jest.spyOn(provider, 'releaseLease')
    const reason = new Error('preview expired')
    const rejected = expect(service.updateLastActivityAt(boxId, new Date(1), abort.signal)).rejects.toBe(reason)
    await pause.acquired
    abort.abort(reason)
    pause.resume()
    await rejected

    expect(cleanup).not.toHaveBeenCalled()
    expect(await redis.get(lockKey)).toBe('existing-owner')
  })

  it('retains the successful heartbeat throttle until its TTL', async () => {
    const first = new Date(1000)
    await service.updateLastActivityAt(boxId, first)
    const owner = await redis.get(lockKey)
    await service.updateLastActivityAt(boxId, new Date(2000))

    expect(owner).toBeTruthy()
    expect(await redis.get(lockKey)).toBe(owner)
    expect(await redis.ttl(lockKey)).toBeGreaterThan(0)
    expect(await redis.zscore('box:activity', boxId)).toBe(String(first.getTime()))
  })
})
