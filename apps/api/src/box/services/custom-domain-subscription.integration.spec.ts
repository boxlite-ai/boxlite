/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { randomUUID } from 'node:crypto'
import axios from 'axios'
import { Redis } from 'ioredis'
import { CustomDomainSubscriptionService } from './custom-domain-subscription.service'

jest.mock('axios')
const get = axios.get as jest.Mock
const describeWithRedis = process.env.BOXLITE_TEST_REDIS_URL ? describe : describe.skip
const org = randomUUID()
const key = `commerce:custom-domain-subscription:v2:{${org}}`
const lock = `${key}:refresh`

describeWithRedis('custom domain subscription (real Redis)', () => {
  let redis: Redis
  let service: CustomDomainSubscriptionService
  let replica: CustomDomainSubscriptionService
  let billingEnabled = true
  const config = {
    get: (name: string) =>
      billingEnabled ? (name === 'billingApiUrl' ? 'https://commerce.example.test' : 'test-service-token') : undefined,
  }
  const activePlan = (cycleTo = Date.now() + 3 * 86_400_000) => ({
    data: { plan: { status: 'active', entitlements: 'active', cycleTo: new Date(cycleTo).toISOString() } },
  })

  beforeAll(async () => {
    redis = new Redis(process.env.BOXLITE_TEST_REDIS_URL!, { lazyConnect: true, maxRetriesPerRequest: 0 })
    await redis.connect()
    service = new CustomDomainSubscriptionService(redis, config as never)
    replica = new CustomDomainSubscriptionService(redis, config as never)
  })
  beforeEach(async () => {
    billingEnabled = true
    get.mockReset()
    await redis.del(key, lock)
  })
  afterEach(() => {
    jest.restoreAllMocks()
    jest.useRealTimers()
  })
  afterAll(async () => {
    await redis.del(key, lock)
    await redis.quit()
  })

  it('ignores legacy one-day grants when the cache namespace changes', async () => {
    const oldKey = key.replace(':v2:', ':v1:')
    await redis.set(oldKey, JSON.stringify({ status: 'active', expiresAt: Date.now() + 86_400_000 }), 'EX', 86400)
    try {
      expect(await service.read(org)).toEqual({ status: 'unavailable', expiresAt: 0 })
      get.mockResolvedValue({ data: {} })
      expect((await service.refresh(org)).status).toBe('required')
      expect(get).toHaveBeenCalledTimes(1)
    } finally {
      await redis.del(oldKey)
    }
  })

  it('shares a one-minute grant without sliding expiry or repeating the existing Commerce request', async () => {
    get.mockResolvedValue(activePlan())
    const grant = await service.refresh(org)
    expect(grant.status).toBe('active')
    expect(await replica.refresh(org)).toEqual(grant)
    expect(await service.read(org)).toEqual(grant)
    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith(`https://commerce.example.test/organization/${org}/plan`, {
      timeout: 2000,
      maxRedirects: 0,
      headers: { authorization: 'Bearer test-service-token' },
    })
    const ttl = await redis.pttl(key)
    expect(ttl).toBeGreaterThan(55_000)
    expect(ttl).toBeLessThanOrEqual(60_000)
    expect(await redis.get(lock)).toBeNull()
  })

  it.each([
    { skew: 30_000, status: 'active' },
    { skew: 120_000, status: 'unavailable' },
  ])('bounds the grant against Redis time with API skew $skew', async ({ skew, status }) => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + skew)
    get.mockResolvedValue(activePlan())
    expect((await service.refresh(org)).status).toBe(status)
    expect(await redis.pttl(key)).toBeLessThanOrEqual(60_000)
  })

  it('bounds the cache by the paid cycle even when it ends before one minute', async () => {
    const end = Date.now() + 20_000
    get.mockResolvedValue(activePlan(end))
    expect(await service.refresh(org)).toEqual({ status: 'active', expiresAt: end })
    expect(await redis.pttl(key)).toBeLessThanOrEqual(20_000)
  })

  it('rejects a logically expired grant even if Redis still holds the key and Commerce is down', async () => {
    get.mockResolvedValue(activePlan())
    const grant = await service.refresh(org)
    jest.spyOn(Date, 'now').mockReturnValue(grant.expiresAt + 1)
    expect(await redis.exists(key)).toBe(1)
    expect(await service.read(org)).toEqual({ status: 'unavailable', expiresAt: 0 })
    get.mockRejectedValue(new Error('timeout'))
    expect((await service.refresh(org)).status).toBe('unavailable')
  })

  it('refreshes a denied subscription after the short retry cache expires', async () => {
    get.mockResolvedValueOnce({ data: {} })
    const denied = await service.refresh(org)
    expect(denied.status).toBe('required')
    expect(await redis.pttl(key)).toBeLessThanOrEqual(30_000)
    expect(await replica.refresh(org)).toEqual(denied)
    expect(get).toHaveBeenCalledTimes(1)
    jest.spyOn(Date, 'now').mockReturnValue(denied.expiresAt + 1)
    get.mockResolvedValueOnce(activePlan())
    expect((await service.refresh(org)).status).toBe('active')
    expect(get).toHaveBeenCalledTimes(2)
  })

  it.each([null, { plan: { status: 'unknown' } }, { plan: { status: 'active', cycleTo: 'bad' } }])(
    'does not grant access for a malformed Commerce response %j',
    async (data) => {
      get.mockResolvedValue({ data })
      expect((await service.refresh(org)).status).toBe('unavailable')
      expect(await redis.pttl(key)).toBeLessThanOrEqual(30_000)
      await replica.refresh(org)
      expect(get).toHaveBeenCalledTimes(1)
    },
  )

  it.each(['{invalid', 'null', '{"status":"active"}', '{"status":"active","expiresAt":"forever"}'])(
    'does not trust a malformed cache entry %s',
    async (raw) => {
      await redis.set(key, raw)
      expect(await service.read(org)).toEqual({ status: 'unavailable', expiresAt: 0 })
      expect(get).not.toHaveBeenCalled()
    },
  )

  it('coalesces concurrent cache misses across instances', async () => {
    let finish!: (value: ReturnType<typeof activePlan>) => void
    let started!: () => void
    const began = new Promise<void>((resolve) => {
      started = resolve
    })
    get.mockImplementationOnce(() => {
      started()
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    const pending = service.refresh(org)
    await began
    try {
      expect((await replica.refresh(org)).status).toBe('unavailable')
      expect(get).toHaveBeenCalledTimes(1)
    } finally {
      finish(activePlan())
    }
    const granted = await pending
    expect(granted.status).toBe('active')
    expect(await replica.refresh(org)).toEqual(granted)
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('rejects a late grant whose refresh owner was replaced by a newer denial', async () => {
    let finish!: (value: ReturnType<typeof activePlan>) => void
    let started!: () => void
    const began = new Promise<void>((resolve) => {
      started = resolve
    })
    get.mockImplementationOnce(() => {
      started()
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    const pending = service.refresh(org)
    await began
    let denied
    try {
      // Expire the first lease at the controlled HTTP boundary, without waiting ten seconds.
      await redis.pexpireat(lock, 1)
      get.mockResolvedValueOnce({ data: {} })
      denied = await replica.refresh(org)
      expect(denied.status).toBe('required')
      await redis.set(lock, 'new-refresh-owner', 'PX', 10_000)
    } finally {
      finish(activePlan())
    }
    expect(await pending).toEqual(denied)
    expect(await service.read(org)).toEqual(denied)
    expect(await redis.get(lock)).toBe('new-refresh-owner')
  })

  it('fails closed without calling Commerce when Redis cannot coordinate a refresh', async () => {
    jest.spyOn(redis, 'set').mockRejectedValue(new Error('Redis unavailable'))
    expect((await service.refresh(org)).status).toBe('unavailable')
    expect(get).not.toHaveBeenCalled()
  })

  it('bounds a stalled cache read', async () => {
    jest.useFakeTimers()
    jest.spyOn(redis, 'get').mockImplementation(() => new Promise(() => {}))
    const pending = service.read(org)
    await jest.advanceTimersByTimeAsync(1_000)
    expect(await pending).toEqual({ status: 'unavailable', expiresAt: 0 })
    expect(get).not.toHaveBeenCalled()
  })

  it('fails closed when Commerce is not configured', async () => {
    billingEnabled = false
    expect((await service.refresh(org)).status).toBe('unavailable')
    expect(get).not.toHaveBeenCalled()
  })
})
