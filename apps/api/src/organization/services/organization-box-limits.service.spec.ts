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

describe('OrganizationBoxLimitsService', () => {
  let service: OrganizationBoxLimitsService
  let config: Record<string, string>

  beforeEach(() => {
    jest.resetAllMocks()
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    config = { billingApiUrl: 'https://commerce.test/api/billing/', 'usageExport.token': 'service-token' }
    service = new OrganizationBoxLimitsService({ get: (key: string) => config[key] } as never)
  })

  afterEach(() => jest.restoreAllMocks())

  function response(plan: Record<string, unknown> = {}) {
    get.mockResolvedValue({
      data: { plan: { perBoxLimits: subscribed, ...plan } },
    })
  }

  it.each([
    ['no subscription metadata', {}],
    ['active metadata', { planId: 'starter', status: 'active' }],
    ['a new status', { planId: 'starter', status: 'trialing' }],
    ['legacy suspension metadata', { planId: 'starter', status: 'past_due', entitlements: 'suspended' }],
    ['legacy cancellation metadata', { planId: 'starter', status: 'canceled' }],
  ])('uses the effective Commerce grant with %s without changing stored quotas', async (_name, plan) => {
    response(plan)
    expect(await service.resolve(organization)).toEqual(subscribed)
    expect(organization).toEqual({ id: 'org/1', ...baseline })
    expect(get).toHaveBeenCalledWith('https://commerce.test/api/billing/organization/org%2F1/plan', {
      timeout: 2_000,
      maxRedirects: 0,
      headers: { authorization: 'Bearer service-token' },
    })
  })

  it.each([
    ['no subscription', {}],
    ['old Commerce', { plan: { planId: 'pro', status: 'active' } }],
    ['malformed response', null],
    ['malformed plan', { plan: null }],
    ['malformed grant', { plan: { perBoxLimits: null } }],
    ['non-object grant', { plan: { perBoxLimits: '16/32/100' } }],
    ['array grant', { plan: { perBoxLimits: [16, 32, 100] } }],
  ])('keeps baseline limits for %s', async (_name, data) => {
    get.mockResolvedValue({ data })
    expect(await service.resolve(organization)).toEqual(baseline)
  })

  it.each(['maxCpuPerBox', 'maxMemoryPerBox', 'maxDiskPerBox'])('rejects invalid %s grants', async (key) => {
    for (const value of [undefined, null, 0, -1, 1.5, '16', Number.MAX_SAFE_INTEGER + 1]) {
      response({ perBoxLimits: { ...subscribed, [key]: value } })
      expect(await service.resolve(organization)).toEqual(baseline)
    }
  })

  it('does not return unrecognized Commerce fields as organization properties', async () => {
    response({ perBoxLimits: { ...subscribed, suspended: false, extra: 'unexpected' } })
    expect(await service.resolve(organization)).toEqual(subscribed)
  })

  it.each([
    { maxCpuPerBox: 2, maxMemoryPerBox: 8, maxDiskPerBox: 10 },
    { maxCpuPerBox: 4, maxMemoryPerBox: 8, maxDiskPerBox: 20 },
    { maxCpuPerBox: 16, maxMemoryPerBox: 64, maxDiskPerBox: 200 },
    { maxCpuPerBox: 0, maxMemoryPerBox: -1, maxDiskPerBox: 0 },
  ])('preserves an administrator quota %j without consulting Commerce', async (custom) => {
    expect(await service.resolve({ ...organization, ...custom })).toEqual(custom)
    expect(get).not.toHaveBeenCalled()
  })

  it.each([
    ['disabled billing', 'billingApiUrl', ''],
    ['missing token', 'usageExport.token', ''],
    ['invalid URL', 'billingApiUrl', 'invalid'],
    ['credentials in URL', 'billingApiUrl', 'https://user:password@commerce.test'],
    ['query in URL', 'billingApiUrl', 'https://commerce.test/?token=secret'],
    ['fragment in URL', 'billingApiUrl', 'https://commerce.test/#fragment'],
    ['wrong protocol', 'billingApiUrl', 'file:///tmp/commerce'],
  ])('does not grant uplift with %s', async (_name, key, value) => {
    config[key] = value
    expect(await service.resolve(organization)).toEqual(baseline)
    expect(get).not.toHaveBeenCalled()
  })

  it('follows the current grant and falls back when it is removed or unavailable', async () => {
    response()
    expect(await service.resolve(organization)).toEqual(subscribed)
    response({ perBoxLimits: baseline })
    expect(await service.resolve(organization)).toEqual(baseline)
    const changedLimits = { maxCpuPerBox: 8, maxMemoryPerBox: 16, maxDiskPerBox: 60 }
    response({ perBoxLimits: changedLimits })
    expect(await service.resolve(organization)).toEqual(changedLimits)
    get.mockResolvedValue({ data: {} })
    expect(await service.resolve(organization)).toEqual(baseline)
    get.mockRejectedValue(new Error('secret response body'))
    expect(await service.resolve(organization)).toEqual(baseline)
    expect(Logger.prototype.warn).toHaveBeenCalledWith(expect.not.stringContaining('secret'))
    expect(get).toHaveBeenCalledTimes(5)
  })
})
