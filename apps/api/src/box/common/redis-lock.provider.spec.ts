/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { LockCode, RedisLockProvider } from './redis-lock.provider'

describe('RedisLockProvider', () => {
  it('uses compare-and-delete when the caller owns a tokenized lock', async () => {
    const redis = {
      eval: jest.fn().mockResolvedValue(1),
      del: jest.fn(),
    }
    const provider = new RedisLockProvider(redis as never)

    await provider.unlock('billing-access:org-1', new LockCode('owner-1'))

    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('get', KEYS[1])"),
      1,
      'billing-access:org-1',
      'owner-1',
    )
    expect(redis.del).not.toHaveBeenCalled()
  })

  it('keeps legacy unconditional unlock behavior when no token is supplied', async () => {
    const redis = {
      eval: jest.fn(),
      del: jest.fn().mockResolvedValue(1),
    }
    const provider = new RedisLockProvider(redis as never)

    await provider.unlock('legacy-lock')

    expect(redis.del).toHaveBeenCalledWith('legacy-lock')
    expect(redis.eval).not.toHaveBeenCalled()
  })
})
