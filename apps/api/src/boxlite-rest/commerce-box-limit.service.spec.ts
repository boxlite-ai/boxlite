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

const makeService = (settings: Record<string, unknown> = {}) => {
  const values = {
    billingApiUrl: 'https://commerce.test/api/billing/',
    'usageExport.token': 'shared-token',
    ...settings,
  }
  const configService = {
    get: jest.fn((key: string) => values[key as keyof typeof values]),
  }
  return { service: new CommerceBoxLimitService(configService as never), configService }
}

const catalog = [
  { id: 'starter', concurrencyLimit: 2 },
  { id: 'pro', concurrencyLimit: 8 },
]

function expectUnavailable(error: unknown): void {
  expect(error).toBeInstanceOf(BoxCreationAdmissionUnavailableError)
  const exception = error as BoxCreationAdmissionUnavailableError
  expect(exception.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE)
  expect(exception.getResponse()).toEqual(
    expect.objectContaining({ code: BOX_CREATION_ADMISSION_UNAVAILABLE_CODE }),
  )
}

beforeEach(() => {
  get.mockReset()
})

describe('CommerceBoxLimitService', () => {
  it('does not contact Commerce when BILLING_API_URL is absent', async () => {
    const { service } = makeService({ billingApiUrl: undefined })

    await expect(service.resolveMaxCreatedBoxes('org-1')).resolves.toBeUndefined()
    expect(get).not.toHaveBeenCalled()
  })

  it('fetches the catalog and organization plan in parallel and resolves the subscribed limit', async () => {
    let resolveCatalog!: (value: { data: unknown }) => void
    let resolveOrganization!: (value: { data: unknown }) => void
    get
      .mockReturnValueOnce(new Promise((resolve) => (resolveCatalog = resolve)))
      .mockReturnValueOnce(new Promise((resolve) => (resolveOrganization = resolve)))

    const resolving = makeService().service.resolveMaxCreatedBoxes('org/with space')

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

  it('rejects a configured Commerce API without the shared token before making a request', async () => {
    const { service } = makeService({ 'usageExport.token': undefined })

    const error = await service.resolveMaxCreatedBoxes('org-1').catch((caught) => caught)
    expectUnavailable(error)
    expect(get).not.toHaveBeenCalled()
  })

  it.each([
    ['timeout', Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }), { data: {} }],
    ['Commerce 5xx', Object.assign(new Error('unavailable'), { response: { status: 503 } }), { data: {} }],
    ['empty catalog', { data: [] }, { data: {} }],
    ['invalid catalog', { data: [{ id: 'starter', concurrencyLimit: -1 }] }, { data: {} }],
    ['invalid organization response', { data: catalog }, { data: { plan: null } }],
    ['unexpected no-plan fields', { data: catalog }, { data: { subscription: null } }],
    ['unknown subscribed plan', { data: catalog }, { data: { plan: { planId: 'custom' } } }],
  ])('fails closed for %s', async (_label, catalogResult, organizationResult) => {
    if (catalogResult instanceof Error) {
      get.mockRejectedValueOnce(catalogResult).mockResolvedValueOnce(organizationResult)
    } else {
      get.mockResolvedValueOnce(catalogResult).mockResolvedValueOnce(organizationResult)
    }

    const error = await makeService().service.resolveMaxCreatedBoxes('org-1').catch((caught) => caught)
    expectUnavailable(error)
  })
})
