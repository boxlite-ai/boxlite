/*
 * SPDX-License-Identifier: AGPL-3.0
 * Copyright (c) 2025 BoxLite AI
 */

import type { IncomingMessage } from 'http'
import type { ThrottlerModuleOptions, ThrottlerStorage } from '@nestjs/throttler'
import { BoxliteRequestThrottleService } from './boxlite-request-throttle.service'

describe('BoxliteRequestThrottleService', () => {
  const options: ThrottlerModuleOptions = {
    throttlers: [
      { name: 'anonymous', limit: 20, ttl: 60_000 },
      { name: 'authenticated', limit: 200, ttl: 60_000 },
    ],
  }

  function makeHarness(record = { totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 }) {
    const storage = {
      increment: jest.fn().mockResolvedValue(record),
    } as unknown as ThrottlerStorage
    const organizationService = {
      findOne: jest.fn().mockResolvedValue({
        authenticatedRateLimit: 50,
        authenticatedRateLimitTtlSeconds: 30,
      }),
    }
    const service = new BoxliteRequestThrottleService(options, storage, organizationService as never)
    return { service, storage, organizationService }
  }

  it('does not let websocket clients rotate anonymous quota keys with forwarded headers', async () => {
    const { service, storage } = makeHarness()
    const firstRequest = {
      headers: { 'x-forwarded-for': '203.0.113.8, 198.51.100.24' },
      socket: { remoteAddress: '10.0.0.5' },
    } as unknown as IncomingMessage
    const secondRequest = {
      headers: { 'x-forwarded-for': '192.0.2.9, 198.51.100.24' },
      socket: { remoteAddress: '10.0.0.5' },
    } as unknown as IncomingMessage

    await expect(service.consumeAnonymous(firstRequest)).resolves.toEqual({ allowed: true })
    await expect(service.consumeAnonymous(secondRequest)).resolves.toEqual({ allowed: true })
    expect(storage.increment).toHaveBeenNthCalledWith(
      1,
      'anonymous-anonymous:198.51.100.24',
      60_000,
      20,
      60_000,
      'anonymous',
    )
    expect(storage.increment).toHaveBeenNthCalledWith(
      2,
      'anonymous-anonymous:198.51.100.24',
      60_000,
      20,
      60_000,
      'anonymous',
    )
  })

  it('ignores forwarded headers from direct untrusted websocket peers', async () => {
    const { service, storage } = makeHarness()
    const request = {
      headers: { 'x-forwarded-for': '203.0.113.8' },
      socket: { remoteAddress: '198.51.100.24' },
    } as unknown as IncomingMessage

    await expect(service.consumeAnonymous(request)).resolves.toEqual({ allowed: true })
    expect(storage.increment).toHaveBeenCalledWith('anonymous-anonymous:198.51.100.24', 60_000, 20, 60_000, 'anonymous')
  })

  it('falls back to the socket address when no forwarded client IP is present', async () => {
    const { service, storage } = makeHarness()
    const request = {
      headers: {},
      socket: { remoteAddress: '198.51.100.24' },
    } as unknown as IncomingMessage

    await expect(service.consumeAnonymous(request)).resolves.toEqual({ allowed: true })
    expect(storage.increment).toHaveBeenCalledWith('anonymous-anonymous:198.51.100.24', 60_000, 20, 60_000, 'anonymous')
  })

  it('shares the authenticated guard keyspace and honors organization overrides', async () => {
    const { service, storage, organizationService } = makeHarness({
      totalHits: 51,
      timeToExpire: 30,
      isBlocked: true,
      timeToBlockExpire: 7,
    })

    await expect(service.consumeAuthenticated('org-1')).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 7,
    })
    expect(organizationService.findOne).toHaveBeenCalledWith('org-1')
    expect(storage.increment).toHaveBeenCalledWith('authenticated-auth:org:org-1', 30_000, 50, 30_000, 'authenticated')
  })

  it('uses an explicitly configured block duration and clamps Retry-After to one second', async () => {
    const storage = {
      increment: jest.fn().mockResolvedValue({
        totalHits: 21,
        timeToExpire: 60,
        isBlocked: true,
        timeToBlockExpire: 0,
      }),
    } as unknown as ThrottlerStorage
    const service = new BoxliteRequestThrottleService(
      {
        throttlers: [{ name: 'anonymous', limit: 20, ttl: 60_000, blockDuration: 5_000 }],
      },
      storage,
      { findOne: jest.fn() } as never,
    )
    const request = {
      headers: {},
      socket: { remoteAddress: '198.51.100.24' },
    } as unknown as IncomingMessage

    await expect(service.consumeAnonymous(request)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    })
    expect(storage.increment).toHaveBeenCalledWith('anonymous-anonymous:198.51.100.24', 60_000, 20, 5_000, 'anonymous')
  })

  it('does not touch storage or organizations when a limiter is not configured', async () => {
    const storage = { increment: jest.fn() } as unknown as ThrottlerStorage
    const organizationService = { findOne: jest.fn() }
    const service = new BoxliteRequestThrottleService({ throttlers: [] }, storage, organizationService as never)
    const request = {
      headers: {},
      socket: { remoteAddress: '198.51.100.24' },
    } as unknown as IncomingMessage

    await expect(service.consumeAnonymous(request)).resolves.toEqual({ allowed: true })
    await expect(service.consumeAuthenticated('org-1')).resolves.toEqual({ allowed: true })
    expect(storage.increment).not.toHaveBeenCalled()
    expect(organizationService.findOne).not.toHaveBeenCalled()
  })
})
