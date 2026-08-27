/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { LockCode, RedisLockProvider, withRedisLockLease } from './redis-lock.provider'

describe('RedisLockProvider leases', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('releases only the owner that acquired the lease', async () => {
    const redis = {
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockResolvedValue(1),
    }
    const provider = new RedisLockProvider(redis as any)

    const lease = await provider.acquireLease('usage-period-box-1', 10)
    const owner = redis.set.mock.calls[0][1]
    await lease?.release()

    expect(owner).not.toBe('1')
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('del', KEYS[1])"),
      1,
      'usage-period-box-1',
      owner,
    )
  })

  it('does not let an expired owner delete a replacement owner', async () => {
    let currentOwner = 'replacement-owner'
    const redis = {
      eval: jest.fn(async (_script: string, _keys: number, _key: string, owner: string) => {
        if (currentOwner === owner) {
          currentOwner = ''
          return 1
        }
        return 0
      }),
    }
    const provider = new RedisLockProvider(redis as any)
    const warn = jest.spyOn((provider as any).logger, 'warn').mockImplementation()

    await provider.releaseLease('shared-key', new LockCode('expired-owner'))

    expect(currentOwner).toBe('replacement-owner')
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("if redis.call('get', KEYS[1]) == ARGV[1]"),
      1,
      'shared-key',
      'expired-owner',
    )
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('shared-key'))
  })

  it('renews an acquired lease before its TTL expires', async () => {
    jest.useFakeTimers()
    const redis = {
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockResolvedValue(1),
    }
    const provider = new RedisLockProvider(redis as any)

    const lease = await provider.acquireLease('archive-usage-periods', 10)
    await jest.advanceTimersByTimeAsync(5_000)

    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('expire', KEYS[1], ARGV[2])"),
      1,
      'archive-usage-periods',
      expect.any(String),
      10,
    )
    await lease?.release()
  })

  it('aborts before expiry when a renewal command never settles', async () => {
    jest.useFakeTimers()
    const redis = {
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn(() => new Promise(() => undefined)),
    }
    const provider = new RedisLockProvider(redis as any)
    const lease = await provider.acquireLease('stalled-renewal', 2)

    await jest.advanceTimersByTimeAsync(1_800)

    expect(lease?.signal.aborted).toBe(true)
    expect(lease?.signal.reason).toEqual(expect.objectContaining({ message: expect.stringContaining('timed out') }))
    const release = expect(lease?.release()).rejects.toThrow('renewal timed out')
    await jest.advanceTimersByTimeAsync(250)
    await release
  })

  it('preserves the operation error when release also fails', async () => {
    const operationError = new Error('operation failed')
    const releaseError = new Error('release failed')
    const onSuppressedReleaseError = jest.fn()
    const lease = {
      signal: new AbortController().signal,
      release: jest.fn().mockRejectedValue(releaseError),
    }

    await expect(
      withRedisLockLease(
        lease as any,
        async () => {
          throw operationError
        },
        onSuppressedReleaseError,
      ),
    ).rejects.toBe(operationError)
    expect(onSuppressedReleaseError).toHaveBeenCalledWith(releaseError)
  })

  it('cancels an in-flight wait and releases a lease that arrives afterward', async () => {
    const provider = new RedisLockProvider({} as any)
    const controller = new AbortController()
    let finishRelease!: () => void
    const released = new Promise<void>((resolve) => {
      finishRelease = resolve
    })
    const lease = { release: jest.fn().mockImplementation(async () => finishRelease()) }
    let finishAcquire!: (lease: any) => void
    jest.spyOn(provider, 'acquireLease').mockReturnValue(
      new Promise((resolve) => {
        finishAcquire = resolve
      }),
    )

    const waiting = expect(provider.waitForLease('usage-period-box-1', 60, controller.signal)).rejects.toThrow(
      'service is shutting down',
    )
    controller.abort(new Error('service is shutting down'))
    await waiting

    finishAcquire(lease)
    await released
    expect(lease.release).toHaveBeenCalledTimes(1)
  })
})
