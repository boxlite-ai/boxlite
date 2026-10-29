/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0 */

import { randomUUID } from 'node:crypto'
import axios from 'axios'
import Redis from 'ioredis'
import { OrganizationBoxLimitsService } from './organization-box-limits.service'

jest.mock('axios')
const get = jest.mocked(axios.get)
const redisUrl = process.env.BOXLITE_TEST_REDIS_URL
const describeWithRedis = redisUrl ? describe : describe.skip

describeWithRedis('OrganizationBoxLimitsService (integration, real Redis)', () => {
  const baseline = { maxCpuPerBox: 4, maxMemoryPerBox: 8, maxDiskPerBox: 10 }
  const subscribed = { maxCpuPerBox: 16, maxMemoryPerBox: 32, maxDiskPerBox: 100 }
  const organization = { id: randomUUID(), ...baseline }
  const key = `commerce:box-resource-limits:v1:${organization.id}`
  const config = { billingApiUrl: 'https://commerce.test/api/billing', 'usageExport.token': 'test-token' }
  let firstRedis: Redis
  let secondRedis: Redis

  beforeAll(async () => {
    if (!redisUrl) throw new Error('BOXLITE_TEST_REDIS_URL is required')
    const options = { lazyConnect: true, commandTimeout: 1_000, maxRetriesPerRequest: 0 }
    firstRedis = new Redis(redisUrl, options)
    secondRedis = new Redis(redisUrl, options)
    await Promise.all([firstRedis.connect(), secondRedis.connect()])
  })

  afterAll(async () => {
    try {
      if (firstRedis?.status === 'ready') await firstRedis.del(key)
    } finally {
      firstRedis?.disconnect()
      secondRedis?.disconnect()
    }
  })

  it('shares the grant between instances for 30 seconds, then reads the revoked grant', async () => {
    const makeService = (redis: Redis) =>
      new OrganizationBoxLimitsService({ get: (name: string) => config[name] } as never, redis)
    const first = makeService(firstRedis)
    const second = makeService(secondRedis)
    get.mockResolvedValue({ data: { plan: { perBoxLimits: subscribed } } })
    expect(await first.resolve(organization)).toEqual(subscribed)
    const ttl = await firstRedis.pttl(key)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(30_000)
    get.mockResolvedValue({ data: {} })
    expect(await second.resolve(organization)).toEqual(subscribed)
    expect(get).toHaveBeenCalledTimes(1)
    await new Promise((resolve) => setTimeout(resolve, ttl + 100))
    expect(await second.resolve(organization)).toEqual(baseline)
    expect(get).toHaveBeenCalledTimes(2)
  }, 45_000)
})
