/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import axios, { type AxiosRequestConfig } from 'axios'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BillingApiClient } from './billingApiClient'

const originalAdapter = axios.defaults.adapter

describe('BillingApiClient routing', () => {
  afterEach(() => {
    axios.defaults.adapter = originalAdapter
    vi.restoreAllMocks()
  })

  it('keeps legacy payment calls on the configured billing service and reads V3 data from the core API', async () => {
    const requests: AxiosRequestConfig[] = []
    const adapter = async (config: AxiosRequestConfig) => {
      requests.push(config)
      return { data: {}, status: 200, statusText: 'OK', headers: {}, config }
    }
    axios.defaults.adapter = adapter
    const client = new BillingApiClient('https://legacy-billing.test', 'token', 'https://api.test/api')

    await client.getOrganizationWallet('org-1')
    await client.getBillingOverview('org-1', new Date('2026-07-10T10:00:00.000Z'), new Date('2026-07-10T11:00:00.000Z'))

    expect(requests).toEqual([
      expect.objectContaining({ baseURL: 'https://legacy-billing.test', url: '/organization/org-1/wallet' }),
      expect.objectContaining({ baseURL: 'https://api.test/api', url: '/organization/org-1/billing/overview' }),
    ])
  })

  it('hands core API 401 responses to the dashboard re-authentication flow', async () => {
    axios.defaults.adapter = async (config) => {
      throw Object.assign(new Error('Unauthorized'), {
        config,
        response: { status: 401, data: { message: 'Unauthorized' } },
      })
    }
    const onUnauthorized = vi.fn().mockRejectedValue(new Error('re-authentication started'))
    const client = new BillingApiClient('https://legacy-billing.test', 'token', 'https://api.test/api', onUnauthorized)

    await expect(client.getBillingPricing('org-1')).rejects.toThrow('re-authentication started')
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('uses the core API contract for payment setup, auto-reload, top-ups, and receipts', async () => {
    const requests: AxiosRequestConfig[] = []
    axios.defaults.adapter = async (config) => {
      requests.push(config)
      return { data: {}, status: 200, statusText: 'OK', headers: {}, config }
    }
    const client = new BillingApiClient('https://legacy-billing.test', 'token', 'https://api.test/api')

    await client.getBillingPayment('org-1')
    await client.setupBillingPayment('org-1')
    await client.updateBillingAutoReload('org-1', {
      enabled: true,
      thresholdCents: '2000',
      targetCents: '10000',
    })
    await client.createBillingTopUp('org-1', '50000', 'top-up-request-1')
    await client.getBillingReceipts('org-1', { page: 2, pageSize: 8, query: 'failed top up' })

    expect(requests).toEqual([
      expect.objectContaining({
        baseURL: 'https://api.test/api',
        method: 'get',
        url: '/organization/org-1/billing/payment',
      }),
      expect.objectContaining({
        baseURL: 'https://api.test/api',
        method: 'post',
        url: '/organization/org-1/billing/payment/setup',
      }),
      expect.objectContaining({
        baseURL: 'https://api.test/api',
        data: JSON.stringify({ enabled: true, thresholdCents: '2000', targetCents: '10000' }),
        method: 'put',
        url: '/organization/org-1/billing/auto-reload',
      }),
      expect.objectContaining({
        baseURL: 'https://api.test/api',
        data: JSON.stringify({ amountCents: '50000' }),
        headers: expect.objectContaining({ 'Idempotency-Key': 'top-up-request-1' }),
        method: 'post',
        url: '/organization/org-1/billing/top-ups',
      }),
      expect.objectContaining({
        baseURL: 'https://api.test/api',
        method: 'get',
        params: { page: 2, pageSize: 8, query: 'failed top up' },
        url: '/organization/org-1/billing/receipts',
      }),
    ])
  })
})
