/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}))

import axios from 'axios'
import { HttpStatus } from '@nestjs/common'
import { CommerceBoxLimitService } from './commerce-box-limit.service'
import {
  BOX_CREATION_ADMISSION_UNAVAILABLE_CODE,
  BoxCreationAdmissionUnavailableError,
} from '../box/errors/box-creation-limit.error'

const get = axios.get as jest.Mock

type RedisMock = {
  get: jest.Mock
  set: jest.Mock
}

const makeService = (settings: Record<string, unknown> = {}, redisOverrides: Partial<RedisMock> = {}) => {
  const values = {
    billingApiUrl: 'https://commerce.test/api/billing/',
    'usageExport.token': 'shared-token',
    ...settings,
  }
  const configService = {
    get: jest.fn((key: string) => values[key as keyof typeof values]),
  }
  const redis = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    ...redisOverrides,
  }
  return {
    service: new CommerceBoxLimitService(configService as never, redis as never),
    configService,
    redis,
  }
}

const catalog = [
  { id: 'starter', concurrencyLimit: 2 },
  { id: 'pro', concurrencyLimit: 8 },
]

function expectUnavailable(error: unknown): void {
  expect(error).toBeInstanceOf(BoxCreationAdmissionUnavailableError)
  const exception = error as BoxCreationAdmissionUnavailableError
  expect(exception.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE)
  expect(exception.getResponse()).toEqual(expect.objectContaining({ code: BOX_CREATION_ADMISSION_UNAVAILABLE_CODE }))
}

beforeEach(() => {
  get.mockReset()
})

describe('CommerceBoxLimitService', () => {
  it('does not contact Commerce when BILLING_API_URL is absent', async () => {
    const { service, redis } = makeService({ billingApiUrl: undefined })

    await expect(service.resolveMaxCreatedBoxes('org-1')).resolves.toBeUndefined()
    expect(get).not.toHaveBeenCalled()
    expect(redis.get).not.toHaveBeenCalled()
  })

  it.each([
    ['limit:8', 8],
    ['unlimited', undefined],
  ])('uses the cached resolved limit %s without contacting Commerce', async (cached, expected) => {
    get.mockResolvedValueOnce({ data: catalog }).mockResolvedValueOnce({ data: { plan: { planId: 'pro' } } })
    const { service, redis } = makeService({}, { get: jest.fn().mockResolvedValue(cached) })

    await expect(service.resolveMaxCreatedBoxes('org-1')).resolves.toBe(expected)
    expect(redis.get).toHaveBeenCalledWith('commerce:box-limit:v1:org-1')
    expect(redis.set).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
  })

  it('fetches the catalog and organization plan in parallel and resolves the subscribed limit', async () => {
    let resolveCatalog!: (value: { data: unknown }) => void
    let resolveOrganization!: (value: { data: unknown }) => void
    get
      .mockReturnValueOnce(new Promise((resolve) => (resolveCatalog = resolve)))
      .mockReturnValueOnce(new Promise((resolve) => (resolveOrganization = resolve)))

    const { service, redis } = makeService()
    const resolving = service.resolveMaxCreatedBoxes('org/with space')

    await Promise.resolve()
    await Promise.resolve()
    expect(get).toHaveBeenCalledTimes(2)
    expect(get).toHaveBeenNthCalledWith(
      1,
      'https://commerce.test/api/billing/plan',
      expect.objectContaining({ timeout: 2_000, headers: { authorization: 'Bearer shared-token' } }),
    )
    expect(get).toHaveBeenNthCalledWith(
      2,
      'https://commerce.test/api/billing/organization/org%2Fwith%20space/plan',
      expect.objectContaining({ timeout: 2_000, headers: { authorization: 'Bearer shared-token' } }),
    )

    resolveCatalog({ data: catalog })
    resolveOrganization({ data: { plan: { planId: 'pro', entitlements: 'active' } } })
    await expect(resolving).resolves.toBe(8)
    expect(redis.set).toHaveBeenCalledWith('commerce:box-limit:v1:org%2Fwith%20space', 'limit:8', 'EX', 30)
  })

  it.each([
    ['zero', [{ id: 'free', concurrencyLimit: 0 }], 'free', 0, 'limit:0'],
    ['unlimited', [{ id: 'enterprise', concurrencyLimit: null }], 'enterprise', undefined, 'unlimited'],
  ])('caches a successful %s limit without losing its meaning', async (_label, plans, planId, expected, cached) => {
    get.mockResolvedValueOnce({ data: plans }).mockResolvedValueOnce({ data: { plan: { planId } } })
    const { service, redis } = makeService()

    await expect(service.resolveMaxCreatedBoxes('org-1')).resolves.toBe(expected)
    expect(redis.set).toHaveBeenCalledWith('commerce:box-limit:v1:org-1', cached, 'EX', 30)
  })

  it('coalesces concurrent cache misses for the same organization', async () => {
    get
      .mockResolvedValueOnce({ data: catalog })
      .mockResolvedValueOnce({ data: { plan: { planId: 'pro' } } })
      .mockResolvedValueOnce({ data: catalog })
      .mockResolvedValueOnce({ data: { plan: { planId: 'pro' } } })
    const { service, redis } = makeService()

    const resolved = await Promise.all([
      service.resolveMaxCreatedBoxes('org-1'),
      service.resolveMaxCreatedBoxes('org-1'),
    ])

    expect(resolved).toEqual([8, 8])
    expect(redis.get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledTimes(2)
    expect(redis.set).toHaveBeenCalledTimes(1)
  })

  it('falls back to Commerce when Redis reads or writes fail', async () => {
    get.mockResolvedValueOnce({ data: catalog }).mockResolvedValueOnce({ data: { plan: { planId: 'pro' } } })
    const { service, redis } = makeService(
      {},
      {
        get: jest.fn().mockRejectedValue(new Error('Redis read failed')),
        set: jest.fn().mockRejectedValue(new Error('Redis write failed')),
      },
    )

    await expect(service.resolveMaxCreatedBoxes('org-1')).resolves.toBe(8)
    expect(redis.set).toHaveBeenCalledWith('commerce:box-limit:v1:org-1', 'limit:8', 'EX', 30)
  })

  it.each([
    ['no subscription', {}],
    ['suspended entitlements', { plan: { planId: 'pro', entitlements: 'suspended' } }],
  ])('uses the first public plan for %s', async (_label, organizationPlan) => {
    get.mockResolvedValueOnce({ data: catalog }).mockResolvedValueOnce({ data: organizationPlan })

    await expect(makeService().service.resolveMaxCreatedBoxes('org-1')).resolves.toBe(2)
  })

  it('treats a null concurrency limit as unlimited', async () => {
    get
      .mockResolvedValueOnce({ data: [{ id: 'enterprise', concurrencyLimit: null }] })
      .mockResolvedValueOnce({ data: { plan: { planId: 'enterprise' } } })

    await expect(makeService().service.resolveMaxCreatedBoxes('org-1')).resolves.toBeUndefined()
  })

  it('does not limit a subscribed plan that is absent from the public catalog', async () => {
    get.mockResolvedValueOnce({ data: catalog }).mockResolvedValueOnce({ data: { plan: { planId: 'custom' } } })
    const { service, redis } = makeService()
    const warn = jest.spyOn((service as unknown as { logger: { warn: (message: string) => void } }).logger, 'warn')

    await expect(service.resolveMaxCreatedBoxes('org-1')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/org-1.*custom.*public catalog/))
    expect(redis.set).toHaveBeenCalledWith('commerce:box-limit:v1:org-1', 'unlimited', 'EX', 30)
  })

  it('rejects a configured Commerce API without the shared token before making a request', async () => {
    const { service } = makeService({ 'usageExport.token': undefined })

    const error = await service.resolveMaxCreatedBoxes('org-1').catch((caught) => caught)
    expectUnavailable(error)
    expect(get).not.toHaveBeenCalled()
  })

  it.each([
    ['timeout', Object.assign(new Error('timeout'), { code: 'ECONNABORTED' })],
    ['Commerce 5xx', Object.assign(new Error('unavailable'), { response: { status: 502 } })],
  ])('temporarily allows creation without caching when Commerce is unavailable due to %s', async (_label, failure) => {
    get.mockRejectedValueOnce(failure).mockResolvedValueOnce({ data: {} })
    const { service, redis } = makeService()
    const warn = jest.spyOn((service as unknown as { logger: { warn: (message: string) => void } }).logger, 'warn')

    await expect(service.resolveMaxCreatedBoxes('org-1')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/org-1.*temporarily allowing/))
    expect(redis.set).not.toHaveBeenCalled()
  })

  it.each([
    ['Commerce 4xx', Object.assign(new Error('unauthorized'), { response: { status: 401 } }), { data: {} }],
    ['empty catalog', { data: [] }, { data: {} }],
    ['invalid catalog', { data: [{ id: 'starter', concurrencyLimit: -1 }] }, { data: {} }],
    ['invalid organization response', { data: catalog }, { data: { plan: null } }],
    ['unexpected no-plan fields', { data: catalog }, { data: { subscription: null } }],
  ])('fails closed for %s', async (_label, catalogResult, organizationResult) => {
    if (catalogResult instanceof Error) {
      get.mockRejectedValueOnce(catalogResult).mockResolvedValueOnce(organizationResult)
    } else {
      get.mockResolvedValueOnce(catalogResult).mockResolvedValueOnce(organizationResult)
    }

    const { service, redis } = makeService()
    const error = await service.resolveMaxCreatedBoxes('org-1').catch((caught) => caught)
    expectUnavailable(error)
    expect(redis.set).not.toHaveBeenCalled()
  })
})
