/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { InjectRedis } from '@nestjs-modules/ioredis'
import { Injectable, Logger } from '@nestjs/common'
import { Redis } from 'ioredis'
import { randomUUID } from 'crypto'
import { setTimeout as sleep } from 'timers/promises'

type Acquired = boolean

type WaitForLockOptions = {
  signal?: AbortSignal
  timeoutMs?: number
  retryDelayMs?: number
}

type LeaseAcquisitionOutcome =
  | { kind: 'acquired'; lease: RedisLockLease | null }
  | { kind: 'failed'; error: unknown }

export class LockCode {
  constructor(private readonly code: string) {}

  public getCode(): string {
    return this.code
  }
}

export class RedisLockLease {
  private readonly abortController = new AbortController()
  private renewalTimer: ReturnType<typeof setTimeout> | null = null
  private renewal: Promise<void> = Promise.resolve()
  private renewalError: unknown
  private isReleased = false

  constructor(
    private readonly provider: RedisLockProvider,
    private readonly key: string,
    private readonly ttl: number,
    private readonly code: LockCode,
  ) {
    this.scheduleRenewal()
  }

  async release(): Promise<void> {
    if (this.isReleased) {
      return
    }
    this.isReleased = true
    if (this.renewalTimer) {
      clearTimeout(this.renewalTimer)
    }
    await this.renewal
    await this.provider.unlock(this.key, this.code)
    if (this.renewalError) {
      throw this.renewalError
    }
  }

  get ownerCode(): LockCode {
    return this.code
  }

  get signal(): AbortSignal {
    return this.abortController.signal
  }

  private scheduleRenewal() {
    this.renewalTimer = setTimeout(() => {
      this.renewal = this.provider
        .renew(this.key, this.ttl, this.code)
        .catch((error) => {
          this.renewalError = error
          this.abortController.abort(error)
        })
        .then(() => {
          if (!this.isReleased && !this.renewalError) {
            this.scheduleRenewal()
          }
        })
    }, (this.ttl * 1000) / 2)
  }
}

export async function withRedisLockLease<T>(
  lease: RedisLockLease,
  operation: (signal: AbortSignal) => Promise<T>,
  onSuppressedReleaseError?: (error: unknown) => void,
): Promise<T> {
  const signal = lease.signal ?? new AbortController().signal
  let result: T
  try {
    result = await operation(signal)
    signal.throwIfAborted()
  } catch (error) {
    try {
      await lease.release()
    } catch (releaseError) {
      // Preserve the operation error; it is the actionable failure.
      onSuppressedReleaseError?.(releaseError)
    }
    throw error
  }
  await lease.release()
  return result
}

@Injectable()
export class RedisLockProvider {
  private readonly logger = new Logger(RedisLockProvider.name)

  constructor(@InjectRedis() private readonly redis: Redis) {}

  async lockUntilExpiry(key: string, ttl: number): Promise<Acquired> {
    return this.setLock(key, ttl, new LockCode(randomUUID()))
  }

  async getCode(key: string): Promise<LockCode | null> {
    const keyValue = await this.redis.get(key)
    return keyValue ? new LockCode(keyValue) : null
  }

  async acquireLease(key: string, ttl: number): Promise<RedisLockLease | null> {
    const code = new LockCode(randomUUID())
    if (!(await this.setLock(key, ttl, code))) {
      return null
    }
    return new RedisLockLease(this, key, ttl, code)
  }

  async renew(key: string, ttl: number, code: LockCode): Promise<void> {
    const renewed = await this.redis.eval(
      `if redis.call('get', KEYS[1]) == ARGV[1] then
        return redis.call('expire', KEYS[1], ARGV[2])
      end
      return 0`,
      1,
      key,
      code.getCode(),
      ttl,
    )
    if (renewed !== 1) {
      throw new Error(`Cannot renew Redis lock lease for ${key}: ownership was lost`)
    }
  }

  async unlock(key: string, owner: LockCode): Promise<void> {
    await this.redis.eval(
      `if redis.call('get', KEYS[1]) == ARGV[1] then
        return redis.call('del', KEYS[1])
      end
      return 0`,
      1,
      key,
      owner.getCode(),
    )
  }

  async isLocked(key: string): Promise<boolean> {
    const exists = await this.redis.exists(key)
    return exists === 1
  }

  async waitForLock(key: string, ttl: number, options: WaitForLockOptions = {}): Promise<RedisLockLease> {
    const startedAt = Date.now()
    const retryDelayMs = options.retryDelayMs ?? 50

    while (true) {
      this.throwIfLockWaitEnded(key, startedAt, options)
      const lease = await this.acquireLeaseWhileWaiting(key, ttl, startedAt, options)
      if (lease) return lease

      const elapsedMs = Date.now() - startedAt
      const delayMs =
        options.timeoutMs === undefined ? retryDelayMs : Math.min(retryDelayMs, options.timeoutMs - elapsedMs)
      try {
        await sleep(delayMs, undefined, { signal: options.signal })
      } catch (error) {
        options.signal?.throwIfAborted()
        throw error
      }
    }
  }

  private async acquireLeaseWhileWaiting(
    key: string,
    ttl: number,
    startedAt: number,
    options: WaitForLockOptions,
  ): Promise<RedisLockLease | null> {
    const acquisition = this.acquireLease(key, ttl).then<LeaseAcquisitionOutcome, LeaseAcquisitionOutcome>(
      (lease) => ({ kind: 'acquired', lease }),
      (error) => ({ kind: 'failed', error }),
    )

    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let abortListener: (() => void) | undefined
    const waitEnded = new Promise<{ kind: 'ended'; error: unknown }>((resolve) => {
      if (options.signal) {
        abortListener = () => resolve({ kind: 'ended', error: options.signal?.reason })
        options.signal.addEventListener('abort', abortListener, { once: true })
        if (options.signal.aborted) {
          abortListener()
        }
      }

      if (options.timeoutMs !== undefined) {
        const remainingMs = Math.max(0, options.timeoutMs - (Date.now() - startedAt))
        timeoutId = setTimeout(
          () =>
            resolve({
              kind: 'ended',
              error: new Error(`Timed out waiting for Redis lock ${key} after ${options.timeoutMs}ms`),
            }),
          remainingMs,
        )
      }
    })

    const outcome = await Promise.race([acquisition, waitEnded])
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
    if (abortListener) {
      options.signal?.removeEventListener('abort', abortListener)
    }

    if (outcome.kind === 'ended') {
      void acquisition.then(async (lateOutcome) => {
        if (lateOutcome.kind === 'acquired' && lateOutcome.lease) {
          await lateOutcome.lease.release().catch((releaseError) => {
            this.logger.error(`Error releasing Redis lock ${key} acquired after its wait ended`, releaseError)
          })
        } else if (lateOutcome.kind === 'failed') {
          this.logger.error(`Error acquiring Redis lock ${key} after its wait ended`, lateOutcome.error)
        }
      })
      throw outcome.error
    }

    if (outcome.kind === 'failed') {
      throw outcome.error
    }

    try {
      this.throwIfLockWaitEnded(key, startedAt, options)
    } catch (error) {
      if (outcome.lease) {
        await outcome.lease.release().catch((releaseError) => {
          this.logger.error(`Error releasing Redis lock ${key} acquired after its wait ended`, releaseError)
        })
      }
      throw error
    }

    return outcome.lease
  }

  private throwIfLockWaitEnded(key: string, startedAt: number, options: WaitForLockOptions): void {
    options.signal?.throwIfAborted()
    if (options.timeoutMs !== undefined && Date.now() - startedAt >= options.timeoutMs) {
      throw new Error(`Timed out waiting for Redis lock ${key} after ${options.timeoutMs}ms`)
    }
  }

  private async setLock(key: string, ttl: number, code: LockCode): Promise<Acquired> {
    return !!(await this.redis.set(key, code.getCode(), 'EX', ttl, 'NX'))
  }
}
