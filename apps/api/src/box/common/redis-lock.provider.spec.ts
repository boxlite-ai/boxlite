/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { LockCode, RedisLockProvider, withRedisLockLease } from './redis-lock.provider'

describe('RedisLockProvider owned locks', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('aborts the protected operation when lease renewal fails', async () => {
    jest.useFakeTimers()
    const redis = {
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockResolvedValue(0),
    }
    const provider = new RedisLockProvider(redis as any)
    const lease = await provider.acquireLease('managed-lock', 10)
    let operationStopped = false

    const operation = withRedisLockLease(lease!, async (signal) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      operationStopped = true
    })
    const rejected = expect(operation).rejects.toThrow('ownership was lost')
    await jest.advanceTimersByTimeAsync(5_000)

    await rejected
    expect(operationStopped).toBe(true)
  })

  it('preserves the operation error when release also fails', async () => {
    const operationError = new Error('operation failed')
    const lease = { release: jest.fn().mockRejectedValue(new Error('release failed')) }

    await expect(
      withRedisLockLease(lease as any, async () => {
        throw operationError
      }),
    ).rejects.toBe(operationError)
  })

  it('releases a lease after a successful protected operation', async () => {
    const lease = { release: jest.fn().mockResolvedValue(undefined) }

    await expect(withRedisLockLease(lease as any, async () => 'done')).resolves.toBe('done')

    expect(lease.release).toHaveBeenCalledTimes(1)
  })

  it('retries one transient renewal failure before aborting the lease', async () => {
    jest.useFakeTimers()
    const redis = {
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockRejectedValueOnce(new Error('Redis unavailable')).mockResolvedValue(1),
    }
    const provider = new RedisLockProvider(redis as any)
    const lease = await provider.acquireLease('transient-renewal', 10)

    await jest.advanceTimersByTimeAsync(5_000)
    await Promise.resolve()
    await jest.advanceTimersByTimeAsync(1_000)

    expect(lease?.signal.aborted).toBe(false)
    expect(redis.eval).toHaveBeenCalledTimes(2)
    await lease?.release()
  })

  it('aborts after the renewal retry also fails and schedules no third attempt', async () => {
    jest.useFakeTimers()
    const retryError = new Error('Redis still unavailable')
    const redis = {
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockRejectedValueOnce(new Error('Redis unavailable')).mockRejectedValueOnce(retryError),
    }
    const provider = new RedisLockProvider(redis as any)
    const lease = await provider.acquireLease('failed-renewal-retry', 10)

    await jest.advanceTimersByTimeAsync(5_000)
    await Promise.resolve()
    await jest.advanceTimersByTimeAsync(1_000)
    await jest.advanceTimersByTimeAsync(20_000)

    expect(lease?.signal.aborted).toBe(true)
    expect(lease?.signal.reason).toBe(retryError)
    expect(redis.eval).toHaveBeenCalledTimes(2)
    await expect(lease?.release()).rejects.toBe(retryError)
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
    expect(redis.eval).toHaveBeenCalledTimes(2)
    const release = expect(lease?.release()).rejects.toThrow('renewal timed out')
    await jest.advanceTimersByTimeAsync(250)
    await release
    expect(redis.eval).toHaveBeenCalledTimes(3)
  })

  it('releases the lease when ownership is lost before the operation returns', async () => {
    const ownershipError = new Error('ownership was lost')
    const abortController = new AbortController()
    const lease = {
      signal: abortController.signal,
      release: jest.fn().mockResolvedValue(undefined),
    }

    await expect(
      withRedisLockLease(lease as any, async () => {
        abortController.abort(ownershipError)
      }),
    ).rejects.toBe(ownershipError)

    expect(lease.release).toHaveBeenCalledTimes(1)
  })

  it('reports a suppressed release error without replacing the operation error', async () => {
    const operationError = new Error('operation failed')
    const releaseError = new Error('release failed')
    const onSuppressedReleaseError = jest.fn()
    const lease = { release: jest.fn().mockRejectedValue(releaseError) }

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

  it('releases a lease with the owner token it acquired', async () => {
    const redis = {
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockResolvedValue(1),
    }
    const provider = new RedisLockProvider(redis as any)

    const lease = await provider.acquireLease('owned-lock', 10)
    const ownerCode = redis.set.mock.calls[0][1]
    await lease?.release()

    expect(ownerCode).not.toBe('1')
    expect(redis.eval).toHaveBeenCalledWith(expect.stringContaining("redis.call('del'"), 1, 'owned-lock', ownerCode)
  })

  it('releases a lock only while the caller still owns it', async () => {
    const redis = {
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockResolvedValue(0),
    }
    const provider = new RedisLockProvider(redis as any)
    const owner = new LockCode('owner-1')

    await provider.unlock('usage-period-box-1', owner)

    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('get', KEYS[1])"),
      1,
      'usage-period-box-1',
      owner.getCode(),
    )
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('del', KEYS[1])"),
      1,
      'usage-period-box-1',
      owner.getCode(),
    )
  })

  it('does not release a replacement owner after managed renewal loses ownership', async () => {
    jest.useFakeTimers()
    let currentOwner: string | null = null
    const redis = {
      set: jest.fn(async (_key: string, owner: string) => {
        currentOwner = owner
        return 'OK'
      }),
      get: jest.fn(async () => currentOwner),
      eval: jest.fn(async (script: string, _keys: number, _key: string, owner: string) => {
        if (script.includes("redis.call('expire'")) {
          currentOwner = 'replacement-owner'
          return 0
        }
        if (currentOwner === owner) {
          currentOwner = null
          return 1
        }
        return 0
      }),
    }
    const provider = new RedisLockProvider(redis as any)

    const lease = await provider.acquireLease('legacy-lock', 10)
    await jest.advanceTimersByTimeAsync(5_000)
    await expect(lease?.release()).rejects.toThrow('ownership was lost')

    expect(currentOwner).toBe('replacement-owner')
    jest.useRealTimers()
  })

  it('does not let an expired owner release a replacement owner', async () => {
    let currentOwner = 'replacement-owner'
    const redis = {
      eval: jest.fn(async (script: string, _keys: number, _key: string, owner: string) => {
        if (currentOwner === owner) {
          currentOwner = ''
          return 1
        }
        return 0
      }),
    }
    const provider = new RedisLockProvider(redis as any)

    await provider.unlock('shared-key', new LockCode('expired-owner'))

    expect(currentOwner).toBe('replacement-owner')
  })

  it('renews an acquired lease before its TTL expires', async () => {
    jest.useFakeTimers()
    const redis = {
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockResolvedValue(1),
    }
    const provider = new RedisLockProvider(redis as any)

    const lease = await provider.acquireLease('archive-usage-periods', 60)
    await jest.advanceTimersByTimeAsync(30_000)

    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('expire', KEYS[1], ARGV[2])"),
      1,
      'archive-usage-periods',
      expect.any(String),
      60,
    )

    await lease?.release()
    jest.useRealTimers()
  })

  it('stops renewal and releases with the same owner token', async () => {
    jest.useFakeTimers()
    const redis = {
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockResolvedValue(1),
    }
    const provider = new RedisLockProvider(redis as any)

    const lease = await provider.acquireLease('archive-usage-periods', 60)
    const ownerCode = redis.set.mock.calls[0][1]
    await lease?.release()
    await jest.advanceTimersByTimeAsync(60_000)

    expect(redis.eval).toHaveBeenCalledTimes(1)
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('del', KEYS[1])"),
      1,
      'archive-usage-periods',
      ownerCode,
    )
    jest.useRealTimers()
  })

  it('stops waiting when lock acquisition times out', async () => {
    jest.useFakeTimers()
    const redis = { set: jest.fn().mockResolvedValue(null) }
    const provider = new RedisLockProvider(redis as any)

    const waiting = provider.waitForLock('busy-lock', 60, { timeoutMs: 100, retryDelayMs: 25 })
    const rejected = expect(waiting).rejects.toThrow('Timed out waiting for Redis lock busy-lock')
    await jest.advanceTimersByTimeAsync(100)

    await rejected
  })

  it('stops waiting when the caller aborts', async () => {
    jest.useFakeTimers()
    const redis = { set: jest.fn().mockResolvedValue(null) }
    const provider = new RedisLockProvider(redis as any)
    const controller = new AbortController()

    const waiting = provider.waitForLock('busy-lock', 60, { signal: controller.signal })
    const rejected = expect(waiting).rejects.toThrow('service is shutting down')
    controller.abort(new Error('service is shutting down'))
    await jest.runOnlyPendingTimersAsync()

    await rejected
  })

  it('releases a lease acquired after the caller aborts', async () => {
    const provider = new RedisLockProvider({} as any)
    const controller = new AbortController()
    let releaseFinished!: () => void
    const released = new Promise<void>((resolve) => {
      releaseFinished = resolve
    })
    const lease = { release: jest.fn(async () => releaseFinished()) }
    let finishAcquire!: (lease: any) => void
    jest.spyOn(provider, 'acquireLease').mockReturnValue(
      new Promise((resolve) => {
        finishAcquire = resolve
      }),
    )

    const waiting = provider.waitForLock('busy-lock', 60, { signal: controller.signal })
    const rejected = expect(waiting).rejects.toThrow('service is shutting down')
    controller.abort(new Error('service is shutting down'))

    await rejected
    expect(lease.release).not.toHaveBeenCalled()

    finishAcquire(lease)
    await released
    expect(lease.release).toHaveBeenCalledTimes(1)
  })

  it('releases a lease acquired after the wait deadline', async () => {
    jest.useFakeTimers()
    const provider = new RedisLockProvider({} as any)
    let releaseFinished!: () => void
    const released = new Promise<void>((resolve) => {
      releaseFinished = resolve
    })
    const lease = { release: jest.fn(async () => releaseFinished()) }
    let finishAcquire!: (lease: any) => void
    jest.spyOn(provider, 'acquireLease').mockReturnValue(
      new Promise((resolve) => {
        finishAcquire = resolve
      }),
    )

    const waiting = provider.waitForLock('busy-lock', 60, { timeoutMs: 100 })
    const rejected = expect(waiting).rejects.toThrow('Timed out waiting for Redis lock busy-lock')
    await jest.advanceTimersByTimeAsync(100)

    await rejected
    expect(lease.release).not.toHaveBeenCalled()

    finishAcquire(lease)
    await released
    expect(lease.release).toHaveBeenCalledTimes(1)
  })
})
