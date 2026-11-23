/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { LockCode, LockOwnershipLostError, RedisLockProvider, withRedisLockLease } from './redis-lock.provider'
import calculateSlot from 'cluster-key-slot'

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

  it.each(['acquired', 'busy', 'failed'])('settles a cancellable acquisition when Redis is %s', async (outcome) => {
    const error = new Error('Redis connection failed')
    const redis = {
      set:
        outcome === 'failed'
          ? jest.fn().mockRejectedValue(error)
          : jest.fn().mockResolvedValue(outcome === 'acquired' ? 'OK' : null),
      eval: jest.fn().mockResolvedValue(1),
    }
    const provider = new RedisLockProvider(redis as any)
    const controller = new AbortController()
    const acquisition = provider.acquireLease('cancellable-worker', 30, controller.signal)

    if (outcome === 'failed') {
      await expect(acquisition).rejects.toBe(error)
    } else {
      const lease = await acquisition
      expect(lease === null).toBe(outcome === 'busy')
      await lease?.release()
    }
    controller.abort()
    expect(redis.set).toHaveBeenCalledTimes(1)
    expect(redis.eval).toHaveBeenCalledTimes(outcome === 'acquired' ? 1 : 0)
  })

  it('does not acquire a lease for an already cancelled caller', async () => {
    const redis = { set: jest.fn() }
    const provider = new RedisLockProvider(redis as any)
    const controller = new AbortController()
    const reason = new Error('caller stopped')
    controller.abort(reason)

    await expect(provider.acquireLease('cancelled-worker', 30, controller.signal)).rejects.toBe(reason)
    expect(redis.set).not.toHaveBeenCalled()
  })

  it.each(['busy', 'cleanup failed'])('handles a cancelled acquisition whose late result is %s', async (outcome) => {
    let finishAcquire!: (value: string | null) => void
    const releaseError = new Error('release failed')
    const redis = {
      set: jest.fn(() => new Promise<string | null>((resolve) => (finishAcquire = resolve))),
      eval: jest.fn().mockRejectedValue(releaseError),
    }
    const provider = new RedisLockProvider(redis as any)
    const log = jest.spyOn((provider as any).logger, 'error').mockImplementation()
    const controller = new AbortController()
    const reason = new Error('caller stopped')
    const acquisition = provider.acquireLease('cancelled-worker', 30, controller.signal)
    const rejected = expect(acquisition).rejects.toBe(reason)
    controller.abort(reason)
    await rejected
    finishAcquire(outcome === 'busy' ? null : 'OK')
    await new Promise(setImmediate)

    if (outcome === 'busy') {
      expect(redis.eval).not.toHaveBeenCalled()
      expect(log).not.toHaveBeenCalled()
    } else {
      expect(redis.eval).toHaveBeenCalledTimes(1)
      expect(log).toHaveBeenCalledWith(expect.stringContaining('cancelled-worker'), releaseError)
    }
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

  it.each([null, 'box-1'])('reads the checkpoint for its lease key: %s', async (checkpoint) => {
    const redis = {
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(checkpoint),
      eval: jest.fn().mockResolvedValue(1),
    }
    const provider = new RedisLockProvider(redis as any)
    const lease = await provider.acquireLease('namespace:worker', 30)

    try {
      await expect(lease!.readCheckpoint()).resolves.toBe(checkpoint)
      expect(redis.get).toHaveBeenCalledWith('{namespace:worker}:checkpoint')
    } finally {
      await lease?.release()
    }
  })

  it.each([1, 0])('saves a checkpoint only when the owner matches: %s', async (saved) => {
    const redis = {
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockResolvedValueOnce(saved).mockResolvedValue(1),
    }
    const provider = new RedisLockProvider(redis as any)
    const lease = await provider.acquireLease('namespace:worker', 30)

    try {
      const save = lease!.saveCheckpoint('box-1')
      if (saved) await expect(save).resolves.toBeUndefined()
      else await expect(save).rejects.toBeInstanceOf(LockOwnershipLostError)
      expect(redis.eval).toHaveBeenCalledWith(
        expect.stringContaining("if redis.call('get', KEYS[1]) == ARGV[1]"),
        2,
        'namespace:worker',
        '{namespace:worker}:checkpoint',
        redis.set.mock.calls[0][1],
        'box-1',
      )
    } finally {
      await lease?.release()
    }
  })

  it('keeps checkpoint writes in the existing lease key slot', async () => {
    const redis = {
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockResolvedValue(1),
    }
    const provider = new RedisLockProvider(redis as any)
    const lease = await provider.acquireLease('commerce-billing-state', 30)

    try {
      await lease!.saveCheckpoint('box-1')
      const [, keyCount, ...arguments_] = redis.eval.mock.calls[0]
      const keys = arguments_.slice(0, keyCount) as string[]
      expect(keys[0]).toBe(redis.set.mock.calls[0][0])
      expect(new Set(keys.map(calculateSlot)).size).toBe(1)
    } finally {
      await lease?.release()
    }
  })

  it.each(['readCheckpoint', 'saveCheckpoint'] as const)('bounds a stalled %s operation', async (method) => {
    jest.useFakeTimers()
    const redis = {
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockResolvedValue(1),
    }
    const provider = new RedisLockProvider(redis as any)
    jest.spyOn(provider, method).mockImplementation(() => new Promise<never>(() => undefined))
    const lease = await provider.acquireLease('stalled-checkpoint', 2)

    try {
      const operation = method === 'readCheckpoint' ? lease!.readCheckpoint() : lease!.saveCheckpoint('box-1')
      let settled = false
      const rejected = expect(operation.finally(() => (settled = true))).rejects.toThrow('timed out')
      await jest.advanceTimersByTimeAsync(249)
      expect(settled).toBe(false)
      await jest.advanceTimersByTimeAsync(1)
      await rejected
    } finally {
      await lease?.release()
    }
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
