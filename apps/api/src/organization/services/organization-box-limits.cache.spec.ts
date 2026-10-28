/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0 */

import axios from 'axios'
import { Logger } from '@nestjs/common'
import { OrganizationBoxLimitsService } from './organization-box-limits.service'

jest.mock('axios')
const get = jest.mocked(axios.get)
const baseline = { maxCpuPerBox: 4, maxMemoryPerBox: 8, maxDiskPerBox: 10 }
const subscribed = { maxCpuPerBox: 16, maxMemoryPerBox: 32, maxDiskPerBox: 100 }
const organization = { id: 'org/1', ...baseline }

describe('OrganizationBoxLimitsService cache', () => {
  let service: OrganizationBoxLimitsService
  let config: Record<string, string>
  let redis: { get: jest.Mock; set: jest.Mock }

  const createService = () =>
    new OrganizationBoxLimitsService({ get: (key: string) => config[key] } as never, redis as never)

  beforeEach(() => {
    jest.resetAllMocks()
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    config = { billingApiUrl: 'https://commerce.test/api/billing/', 'usageExport.token': 'service-token' }
    redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK') }
    service = createService()
    get.mockResolvedValue({ data: { plan: { perBoxLimits: subscribed } } })
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  // Store only what the resolver actually writes; expiry validation is exercised separately.
  function shareCache() {
    const contents = new Map<string, string>()
    redis.get.mockImplementation(async (key: string) => contents.get(key) ?? null)
    redis.set.mockImplementation(async (key: string, value: string) => {
      contents.set(key, value)
      return 'OK'
    })
    return contents
  }

  it('shares successful grants across resolver instances without renewing their 30-second lifetime', async () => {
    jest.useFakeTimers()
    shareCache()
    const startedAt = Date.now()
    expect(await service.resolve(organization)).toEqual(subscribed)
    jest.setSystemTime(startedAt + 25_000)
    expect(await createService().resolve(organization)).toEqual(subscribed)
    expect(get).toHaveBeenCalledTimes(1)
    expect(redis.set).toHaveBeenCalledTimes(1)
    expect(redis.set).toHaveBeenCalledWith(
      'commerce:box-resource-limits:v1:org%2F1',
      JSON.stringify({ limits: subscribed, expiresAt: startedAt + 30_000 }),
      'EX',
      30,
    )
    expect(jest.getTimerCount()).toBe(0)
  })

  it.each([
    ['no plan', {}],
    ['old producer', { plan: { planId: 'starter', status: 'active' } }],
    ['explicit baseline', { plan: { perBoxLimits: baseline } }],
  ])('caches a successful %s response as baseline limits', async (_name, data) => {
    shareCache()
    get.mockResolvedValue({ data })
    expect(await service.resolve(organization)).toEqual(baseline)
    expect(await createService().resolve(organization)).toEqual(baseline)
    expect(get).toHaveBeenCalledTimes(1)
    expect(redis.set).toHaveBeenCalledTimes(1)
  })

  it('coalesces 100 simultaneous requests for one organization', async () => {
    let release!: (value: { data: unknown }) => void
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => (markStarted = resolve))
    const response = new Promise<{ data: unknown }>((resolve) => (release = resolve))
    get.mockImplementation(() => {
      markStarted()
      return response as never
    })
    const pending = Promise.all(Array.from({ length: 100 }, () => service.resolve(organization)))
    await started
    release({ data: { plan: { perBoxLimits: subscribed } } })
    expect(await pending).toEqual(Array.from({ length: 100 }, () => subscribed))
    expect(get).toHaveBeenCalledTimes(1)
    expect(redis.get).toHaveBeenCalledTimes(1)
    expect(redis.set).toHaveBeenCalledTimes(1)
  })

  it('keeps different organizations isolated', async () => {
    shareCache()
    const other = { ...organization, id: 'org-2' }
    get.mockResolvedValueOnce({ data: { plan: { perBoxLimits: subscribed } } }).mockResolvedValueOnce({ data: {} })
    expect(await service.resolve(organization)).toEqual(subscribed)
    expect(await service.resolve(other)).toEqual(baseline)
    expect(await service.resolve(organization)).toEqual(subscribed)
    expect(await service.resolve(other)).toEqual(baseline)
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('returns independent copies to concurrent callers', async () => {
    shareCache()
    const [first, second] = await Promise.all([service.resolve(organization), service.resolve(organization)])
    first.maxCpuPerBox = 1
    expect(second).toEqual(subscribed)
    expect(await service.resolve(organization)).toEqual(subscribed)
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('refreshes grants in either direction at expiry without reusing a completed promise', async () => {
    jest.useFakeTimers()
    shareCache()
    expect(await service.resolve(organization)).toEqual(subscribed)
    get.mockResolvedValue({ data: { plan: { perBoxLimits: baseline } } })
    await jest.advanceTimersByTimeAsync(30_000)
    expect(await service.resolve(organization)).toEqual(baseline)
    get.mockResolvedValue({ data: { plan: { perBoxLimits: subscribed } } })
    await jest.advanceTimersByTimeAsync(30_000)
    expect(await service.resolve(organization)).toEqual(subscribed)
    expect(get).toHaveBeenCalledTimes(3)
    expect(redis.set).toHaveBeenCalledTimes(3)
  })

  it.each([null, { plan: null }, { plan: { perBoxLimits: { ...subscribed, maxCpuPerBox: -1 } } }])(
    'does not cache malformed Commerce response %j',
    async (data) => {
      shareCache()
      get.mockResolvedValueOnce({ data })
      expect(await service.resolve(organization)).toEqual(baseline)
      expect(redis.set).not.toHaveBeenCalled()
      expect(await service.resolve(organization)).toEqual(subscribed)
      expect(get).toHaveBeenCalledTimes(2)
    },
  )

  it('retries after a failed shared lookup without caching the fallback', async () => {
    shareCache()
    get.mockRejectedValueOnce(new Error('secret response body'))
    expect(await Promise.all([service.resolve(organization), service.resolve(organization)])).toEqual([
      baseline,
      baseline,
    ])
    expect(get).toHaveBeenCalledTimes(1)
    expect(redis.set).not.toHaveBeenCalled()
    expect(await service.resolve(organization)).toEqual(subscribed)
    expect(get).toHaveBeenCalledTimes(2)
    expect(Logger.prototype.warn).toHaveBeenCalledWith(expect.not.stringContaining('secret'))
  })

  it.each(['get', 'set'] as const)('keeps a verified grant when Redis %s fails', async (operation) => {
    redis[operation].mockRejectedValue(new Error('secret cache error'))
    expect(await service.resolve(organization)).toEqual(subscribed)
    expect(redis[operation]).toHaveBeenCalled()
    expect(Logger.prototype.warn).toHaveBeenCalledWith(expect.not.stringContaining('secret'))
  })

  it.each(['get', 'set'] as const)('bounds a stalled Redis %s to one second and clears timers', async (operation) => {
    jest.useFakeTimers()
    redis[operation].mockReturnValue(new Promise(() => undefined))
    const pending = service.resolve(organization)
    await jest.advanceTimersByTimeAsync(1_000)
    expect(await pending).toEqual(subscribed)
    expect(redis[operation]).toHaveBeenCalled()
    expect(jest.getTimerCount()).toBe(0)
  })

  it('rejects an expired grant even if a timed-out Redis write completes late', async () => {
    jest.useFakeTimers()
    const contents = shareCache()
    let finishWrite!: () => void
    redis.set.mockImplementationOnce(
      (key: string, value: string) =>
        new Promise((resolve) => {
          finishWrite = () => {
            contents.set(key, value)
            resolve('OK')
          }
        }),
    )
    const pending = service.resolve(organization)
    await jest.advanceTimersByTimeAsync(1_000)
    expect(await pending).toEqual(subscribed)
    expect(redis.set).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(30_000)
    finishWrite()
    get.mockResolvedValue({ data: {} })
    expect(await service.resolve(organization)).toEqual(baseline)
    expect(get).toHaveBeenCalledTimes(2)
    expect(jest.getTimerCount()).toBe(0)
  })

  it.each([
    'not-json',
    JSON.stringify({ limits: subscribed }),
    JSON.stringify({ limits: { ...subscribed, maxDiskPerBox: 0 }, expiresAt: Number.MAX_SAFE_INTEGER }),
  ])('repairs a malformed cached entry %s', async (cached) => {
    redis.get.mockResolvedValue(cached)
    expect(await service.resolve(organization)).toEqual(subscribed)
    expect(get).toHaveBeenCalledTimes(1)
    expect(redis.set).toHaveBeenCalledTimes(1)
  })

  it('bypasses a warm cache for administrator overrides or invalid configuration', async () => {
    shareCache()
    await service.resolve(organization)
    redis.get.mockClear()
    get.mockClear()
    const custom = { ...organization, maxDiskPerBox: 20 }
    expect(await service.resolve(custom)).toEqual({ ...baseline, maxDiskPerBox: 20 })
    config['usageExport.token'] = ''
    expect(await service.resolve(organization)).toEqual(baseline)
    expect(redis.get).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
  })
})
