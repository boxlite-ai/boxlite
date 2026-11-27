/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import { OrganizationAccessCache } from './organization-access-cache.service'

const describeIfRedis = process.env.REDIS_HOST ? describe : describe.skip

describeIfRedis('OrganizationAccessCache (integration, real Redis)', () => {
  let redis: Redis
  let cache: OrganizationAccessCache
  const organizationId = randomUUID()
  const valueKey = `organization:${organizationId}`
  const generationKey = `organization-access:generation:${valueKey}`

  beforeAll(async () => {
    redis = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT || 6379),
      password: process.env.REDIS_PASSWORD,
      username: process.env.REDIS_USERNAME,
    })
    await redis.ping()
    cache = new OrganizationAccessCache(redis)
  })

  afterAll(async () => {
    await redis.del(valueKey, generationKey)
    await redis.quit()
  })

  it('atomically rejects a pre-invalidation write and coalesces the replacement load', async () => {
    let release!: (value: Record<string, unknown>) => void
    const pending = new Promise<Record<string, unknown>>((resolve) => (release = resolve))
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => (markStarted = resolve))
    const oldLoader = jest.fn(() => {
      markStarted()
      return pending
    })
    const oldRead = cache.getOrganization(organizationId, oldLoader as any)
    await started
    expect(oldLoader).toHaveBeenCalledTimes(1)

    await cache.invalidateOrganization(organizationId)
    release({ id: organizationId, suspended: false })
    await oldRead
    expect(await redis.get(valueKey)).toBeNull()

    let releaseCurrent!: (value: Record<string, unknown>) => void
    const currentPending = new Promise<Record<string, unknown>>((resolve) => (releaseCurrent = resolve))
    const currentLoader = jest.fn().mockReturnValue(currentPending)
    const first = cache.getOrganization(organizationId, currentLoader as any)
    const second = cache.getOrganization(organizationId, currentLoader as any)
    releaseCurrent({ id: organizationId, suspended: true })
    const [left, right] = await Promise.all([first, second])

    expect(currentLoader).toHaveBeenCalledTimes(1)
    expect(left).toMatchObject({ suspended: true })
    expect(right).toMatchObject({ suspended: true })
    expect(left).not.toBe(right)
    expect(await redis.get(valueKey)).toContain('"suspended":true')
    expect(await redis.ttl(valueKey)).toBeGreaterThan(0)
    expect(await redis.ttl(valueKey)).toBeLessThanOrEqual(60)
  })
})
