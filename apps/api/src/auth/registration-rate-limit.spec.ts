/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ExecutionContext } from '@nestjs/common'
import Redis from 'ioredis'
import { randomUUID } from 'node:crypto'
import { RegistrationRateLimitGuard } from './registration-rate-limit.guard'
import { registrationRateLimitConfig } from '../config/registration-rate-limit-config'

function context(ip: string): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => ({ ip }) }) } as ExecutionContext
}

describe('Registration limit configuration', () => {
  it('defaults to ten requests in 600 seconds without trusted proxies', () => {
    expect(registrationRateLimitConfig({})).toEqual({ limit: 10, ttl: 600, trustedProxies: [] })
  })
  it.each(['0', '-1', '', '1.5', 'oops'])('rejects invalid limit and window %s', (value) => {
    for (const name of ['RATE_LIMIT_REGISTRATION_LIMIT', 'RATE_LIMIT_REGISTRATION_TTL']) {
      expect(() => registrationRateLimitConfig({ [name]: value })).toThrow(name)
    }
  })
  it('parses and deduplicates actual proxy addresses', () => {
    expect(registrationRateLimitConfig({ TRUST_PROXY_CIDRS: '127.0.0.1, ::1/128, 127.0.0.1' }).trustedProxies).toEqual([
      '127.0.0.1',
      '::1/128',
    ])
  })
  it.each(['true', '0.0.0.0/0', '::/0', 'bad-address', '192.0.2.1/99'])('rejects invalid trust %s', (value) => {
    expect(() => registrationRateLimitConfig({ TRUST_PROXY_CIDRS: value })).toThrow('TRUST_PROXY_CIDRS')
  })
})

describe('Registration limiter failure', () => {
  it('refuses registration when Redis cannot execute the counter', async () => {
    const guard = new RegistrationRateLimitGuard(
      { eval: jest.fn().mockRejectedValue(new Error('unavailable')) } as never,
      { getOrThrow: () => ({ limit: 2, ttl: 2 }) } as never,
    )
    await expect(guard.canActivate(context('192.0.2.1'))).rejects.toMatchObject({
      status: 503,
      response: { code: 'registration_rate_limit_unavailable' },
    })
  })
})

const integration = process.env.REDIS_HOST ? describe : describe.skip
integration('Registration limiter with shared Redis', () => {
  const prefix = `registration-test:${randomUUID()}:`
  let first: Redis, second: Redis
  const settings = { limit: 2, ttl: 2 }
  const config = { getOrThrow: () => settings }
  let a: RegistrationRateLimitGuard, b: RegistrationRateLimitGuard
  const key = 'boxlite:registration:ip:192.0.2.1'
  beforeAll(async () => {
    const options = {
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT || 6379),
      username: process.env.REDIS_USERNAME,
      password: process.env.REDIS_PASSWORD,
      db: 1,
      keyPrefix: prefix,
      maxRetriesPerRequest: 0,
      lazyConnect: true,
    }
    first = new Redis(options)
    second = new Redis(options)
    await Promise.all([first.connect(), second.connect()])
    a = new RegistrationRateLimitGuard(first, config as never)
    b = new RegistrationRateLimitGuard(second, config as never)
  })
  beforeEach(async () => {
    settings.limit = 2
    settings.ttl = 2
    await first.del(key, 'boxlite:registration:ip:192.0.2.2')
  })
  afterAll(async () => {
    await first?.del(key, 'boxlite:registration:ip:192.0.2.2')
    first?.disconnect()
    second?.disconnect()
  })
  it('shares an atomic allowance across independent instances and IPv4 representations', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        (i % 2 ? a : b).canActivate(context(i % 2 ? '192.0.2.1' : '::ffff:192.0.2.1')),
      ),
    )
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2)
    for (const result of results.filter((r) => r.status === 'rejected')) {
      expect((result as PromiseRejectedResult).reason).toMatchObject({
        status: 429,
        response: { code: 'registration_rate_limited' },
        retryAfterSeconds: expect.any(Number),
      })
    }
    expect(await first.get(key)).toBe('8')
    await expect(a.canActivate(context('192.0.2.2'))).resolves.toBe(true)
  })
  it('does not extend a fixed window and restores allowance when it expires', async () => {
    await a.canActivate(context('192.0.2.1'))
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await b.canActivate(context('192.0.2.1'))
    await expect(a.canActivate(context('192.0.2.1'))).rejects.toMatchObject({ retryAfterSeconds: 1 })
    const remainingMs = await first.pttl(key)
    expect(remainingMs).toBeGreaterThan(0)
    expect(remainingMs).toBeLessThanOrEqual(900)
    await new Promise((resolve) => setTimeout(resolve, remainingMs + 50))
    expect(await first.exists(key)).toBe(0)
    settings.ttl = 5
    await expect(b.canActivate(context('192.0.2.1'))).resolves.toBe(true)
    expect(await first.pttl(key)).toBeGreaterThan(4000)
  })
})
