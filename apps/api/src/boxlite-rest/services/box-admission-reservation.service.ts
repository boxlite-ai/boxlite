/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { InjectRedis } from '@nestjs-modules/ioredis'
import { Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { Redis } from 'ioredis'

const RESERVATION_TTL_MS = 30_000

const RESERVE_SCRIPT = `
  local redisTime = redis.call('TIME')
  local now = redisTime[1] * 1000 + math.floor(redisTime[2] / 1000)
  local ttl = tonumber(ARGV[2])
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
  local added = redis.call('ZADD', KEYS[1], 'NX', now + ttl, ARGV[1])
  if added ~= 1 then
    return redis.error_reply('box admission reservation token collision')
  end
  redis.call('PEXPIRE', KEYS[1], ttl * 2)
  return redis.call('ZCARD', KEYS[1])
`

const RENEW_SCRIPT = `
  local redisTime = redis.call('TIME')
  local now = redisTime[1] * 1000 + math.floor(redisTime[2] / 1000)
  local expiresAt = tonumber(redis.call('ZSCORE', KEYS[1], ARGV[1]))
  if not expiresAt or expiresAt <= now then
    redis.call('ZREM', KEYS[1], ARGV[1])
    return 0
  end
  local ttl = tonumber(ARGV[2])
  redis.call('ZADD', KEYS[1], 'XX', now + ttl, ARGV[1])
  redis.call('PEXPIRE', KEYS[1], ttl * 2)
  return 1
`

const RELEASE_SCRIPT = `
  local redisTime = redis.call('TIME')
  local now = redisTime[1] * 1000 + math.floor(redisTime[2] / 1000)
  local expiresAt = tonumber(redis.call('ZSCORE', KEYS[1], ARGV[1]))
  local owned = expiresAt and expiresAt > now
  redis.call('ZREM', KEYS[1], ARGV[1])
  if redis.call('ZCARD', KEYS[1]) == 0 then
    redis.call('DEL', KEYS[1])
  end
  if owned then
    return 1
  end
  return 0
`

export class BoxAdmissionReservationLostError extends Error {}

export class BoxAdmissionReservation {
  private readonly abortController = new AbortController()
  private renewalTimer: ReturnType<typeof setTimeout> | null = null
  private renewal: Promise<void> = Promise.resolve()
  private renewalError: unknown
  private isReleased = false

  constructor(
    public readonly pendingCount: number,
    private readonly ttlMs: number,
    private readonly renewReservation: () => Promise<void>,
    private readonly releaseReservation: () => Promise<void>,
  ) {
    this.scheduleRenewal()
  }

  get signal(): AbortSignal {
    return this.abortController.signal
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

    let releaseError: unknown
    try {
      await this.withTimeout(
        this.releaseReservation(),
        this.operationTimeoutMs,
        'Redis box admission release timed out',
      )
    } catch (error) {
      releaseError = error
    }

    if (this.renewalError) {
      throw this.renewalError
    }
    if (releaseError) {
      throw releaseError
    }
  }

  private get operationTimeoutMs(): number {
    return Math.min(this.ttlMs / 8, 1000)
  }

  private scheduleRenewal(): void {
    this.renewalTimer = setTimeout(() => {
      this.renewal = this.withTimeout(
        this.renewReservation(),
        this.operationTimeoutMs,
        'Redis box admission renewal timed out',
      )
        .catch((error) => {
          if (this.isReleased) {
            return
          }
          this.renewalError = error
          this.abortController.abort(error)
        })
        .then(() => {
          if (!this.isReleased && !this.renewalError) {
            this.scheduleRenewal()
          }
        })
    }, this.ttlMs / 2)
  }

  private async withTimeout(operation: Promise<void>, timeoutMs: number, message: string): Promise<void> {
    let timeout!: ReturnType<typeof setTimeout>
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
    })

    try {
      await Promise.race([operation, timeoutPromise])
    } finally {
      clearTimeout(timeout)
    }
  }
}

export async function withBoxAdmissionReservation<T>(
  reservation: BoxAdmissionReservation,
  operation: (signal: AbortSignal) => Promise<T>,
  onSuppressedReleaseError?: (error: unknown) => void,
): Promise<T> {
  const signal = reservation.signal
  let result: T
  try {
    result = await operation(signal)
    signal.throwIfAborted()
  } catch (error) {
    try {
      await reservation.release()
    } catch (releaseError) {
      onSuppressedReleaseError?.(releaseError)
    }
    throw error
  }

  await reservation.release()
  return result
}

@Injectable()
export class BoxAdmissionReservationService {
  constructor(@InjectRedis() private readonly redis: Redis) {}

  async reserve(organizationId: string): Promise<BoxAdmissionReservation> {
    const key = `box-create-reservations:{${organizationId}}`
    const token = randomUUID()
    const result = await this.redis.eval(RESERVE_SCRIPT, 1, key, token, RESERVATION_TTL_MS)
    const pendingCount = Number(result)
    if (!Number.isSafeInteger(pendingCount) || pendingCount < 1) {
      throw new Error(`Redis returned an invalid box admission reservation count for organization ${organizationId}`)
    }
    return new BoxAdmissionReservation(
      pendingCount,
      RESERVATION_TTL_MS,
      () => this.renewReservation(key, token, RESERVATION_TTL_MS),
      () => this.releaseReservation(key, token),
    )
  }

  private async renewReservation(key: string, token: string, ttlMs: number): Promise<void> {
    const renewed = Number(await this.redis.eval(RENEW_SCRIPT, 1, key, token, ttlMs))
    if (renewed !== 1) {
      throw new BoxAdmissionReservationLostError(`Box admission reservation ownership was lost for ${key}`)
    }
  }

  private async releaseReservation(key: string, token: string): Promise<void> {
    const released = Number(await this.redis.eval(RELEASE_SCRIPT, 1, key, token))
    if (released !== 1) {
      throw new BoxAdmissionReservationLostError(`Box admission reservation ownership was lost for ${key}`)
    }
  }
}
