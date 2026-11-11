/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import { LockOwnershipLostError, RedisLockLease, RedisLockProvider } from './redis-lock.provider'

const describeIfRedis = process.env.REDIS_HOST ? describe : describe.skip

describeIfRedis('Redis lock checkpoints (real Redis)', () => {
  it('preserves progress across leases and rejects writes from an old owner', async () => {
    const redis = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT || 6379),
      username: process.env.REDIS_USERNAME || undefined,
      password: process.env.REDIS_PASSWORD || undefined,
      lazyConnect: true,
      connectTimeout: 2_000,
      maxRetriesPerRequest: 1,
      retryStrategy: null,
    })
    const key = `checkpoint-test:${randomUUID()}`
    const leases: RedisLockLease[] = []
    try {
      await redis.connect()
      const first = await new RedisLockProvider(redis).acquireLease(key, 30)
      expect(first).not.toBeNull()
      leases.push(first!)
      await expect(first!.readCheckpoint()).resolves.toBeNull()
      await first!.saveCheckpoint('box-1')
      expect(await redis.ttl(`{${key}}:checkpoint`)).toBe(-1)
      await first!.release()
      expect(await redis.exists(key)).toBe(0)

      const next = await new RedisLockProvider(redis).acquireLease(key, 30)
      expect(next).not.toBeNull()
      leases.push(next!)
      await expect(next!.readCheckpoint()).resolves.toBe('box-1')
      await next!.saveCheckpoint('box-2')
      await expect(first!.saveCheckpoint('stale-box')).rejects.toBeInstanceOf(LockOwnershipLostError)
      await expect(next!.readCheckpoint()).resolves.toBe('box-2')

      await next!.release()
      await expect(next!.saveCheckpoint('unowned-box')).rejects.toBeInstanceOf(LockOwnershipLostError)
      expect(await redis.get(`{${key}}:checkpoint`)).toBe('box-2')
    } finally {
      try {
        await Promise.all(leases.map((lease) => lease.release()))
      } finally {
        try {
          if (redis.status === 'ready') await redis.del(key, `{${key}}:checkpoint`)
        } finally {
          redis.disconnect()
        }
      }
    }
  }, 10_000)
})
