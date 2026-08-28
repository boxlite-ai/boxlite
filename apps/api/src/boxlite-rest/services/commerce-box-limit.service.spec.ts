/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CommerceBoxLimitService } from './commerce-box-limit.service'

function config(values: Record<string, unknown>) {
  return { get: jest.fn((key: string) => values[key]) } as any
}

function axiosError(status?: number, code?: string) {
  return Object.assign(new Error(status ? `HTTP ${status}` : 'transport failed'), {
    isAxiosError: true,
    code,
    response: status ? { status } : undefined,
  })
}

describe('CommerceBoxLimitService', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('treats an unconfigured Commerce API as unlimited without making a request', async () => {
    const get = jest.fn()
    const service = new CommerceBoxLimitService({ axiosRef: { get } } as any, config({}))

    await expect(service.resolveLimit('org-1')).resolves.toEqual({ kind: 'unlimited' })
    expect(get).not.toHaveBeenCalled()
  })

  it('matches the organization plan and authenticates both Commerce requests', async () => {
    const get = jest.fn((url: string) => {
      if (url.includes('/organization/')) {
        return Promise.resolve({ data: { plan: { planId: 'pro' } } })
      }
      if (url.endsWith('/plan')) {
        return Promise.resolve({ data: [{ id: 'pro', concurrencyLimit: 100 }] })
      }
      throw new Error(`Unexpected URL: ${url}`)
    })
    const service = new CommerceBoxLimitService(
      { axiosRef: { get } } as any,
      config({ billingApiUrl: 'https://commerce.example/api/billing', 'usageExport.token': 'internal-token' }),
    )

    await expect(service.resolveLimit('org/1')).resolves.toEqual({ kind: 'limited', value: 100 })
    expect(get).toHaveBeenCalledTimes(2)
    expect(get).toHaveBeenCalledWith(
      'https://commerce.example/api/billing/plan',
      expect.objectContaining({ headers: { authorization: 'Bearer internal-token' }, timeout: 2_000 }),
    )
    expect(get).toHaveBeenCalledWith(
      'https://commerce.example/api/billing/organization/org%2F1/plan',
      expect.objectContaining({ headers: { authorization: 'Bearer internal-token' }, timeout: 2_000 }),
    )
  })

  it('retries a 5xx once, falls back to 20, and does not cache the failure', async () => {
    jest.useFakeTimers()
    let catalogCalls = 0
    const get = jest.fn((url: string) => {
      if (url.includes('/organization/')) {
        return Promise.resolve({ data: {} })
      }
      if (url.endsWith('/plan')) {
        catalogCalls += 1
        return Promise.reject(axiosError(503))
      }
      throw new Error(`Unexpected URL: ${url}`)
    })
    const service = new CommerceBoxLimitService(
      { axiosRef: { get } } as any,
      config({ billingApiUrl: 'https://commerce.example/api/billing', 'usageExport.token': 'internal-token' }),
    )

    const first = service.resolveLimit('org-1')
    await jest.advanceTimersByTimeAsync(500)
    await expect(first).resolves.toEqual({ kind: 'limited', value: 20 })
    expect(catalogCalls).toBe(2)

    const second = service.resolveLimit('org-1')
    await jest.advanceTimersByTimeAsync(500)
    await expect(second).resolves.toEqual({ kind: 'limited', value: 20 })
    expect(catalogCalls).toBe(4)
  })

  it('caches a successful business fallback from an empty catalog', async () => {
    const get = jest.fn((url: string) => {
      if (url.includes('/organization/')) {
        return Promise.resolve({ data: { plan: { planId: 'missing' } } })
      }
      return Promise.resolve({ data: [] })
    })
    const service = new CommerceBoxLimitService(
      { axiosRef: { get } } as any,
      config({ billingApiUrl: 'https://commerce.example/api/billing', 'usageExport.token': 'internal-token' }),
    )

    await expect(service.resolveLimit('org-1')).resolves.toEqual({ kind: 'limited', value: 20 })
    await expect(service.resolveLimit('org-1')).resolves.toEqual({ kind: 'limited', value: 20 })
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('uses the first public plan when the organization has no plan', async () => {
    const get = jest.fn((url: string) =>
      Promise.resolve(
        url.includes('/organization/')
          ? { data: {} }
          : {
              data: [
                { id: 'starter', concurrencyLimit: 8 },
                { id: 'pro', concurrencyLimit: 100 },
              ],
            },
      ),
    )
    const service = new CommerceBoxLimitService(
      { axiosRef: { get } } as any,
      config({ billingApiUrl: 'https://commerce.example/api/billing', 'usageExport.token': 'internal-token' }),
    )

    await expect(service.resolveLimit('org-1')).resolves.toEqual({ kind: 'limited', value: 8 })
  })

  it('maps a null concurrency limit to unlimited', async () => {
    const get = jest.fn((url: string) =>
      Promise.resolve(
        url.includes('/organization/')
          ? { data: { plan: { planId: 'enterprise' } } }
          : { data: [{ id: 'enterprise', concurrencyLimit: null }] },
      ),
    )
    const service = new CommerceBoxLimitService(
      { axiosRef: { get } } as any,
      config({ billingApiUrl: 'https://commerce.example/api/billing', 'usageExport.token': 'internal-token' }),
    )

    await expect(service.resolveLimit('org-1')).resolves.toEqual({ kind: 'unlimited' })
  })

  it('does not retry or cache a 4xx fallback', async () => {
    const get = jest.fn((url: string) =>
      url.includes('/organization/')
        ? Promise.resolve({ data: {} })
        : Promise.reject(axiosError(401)),
    )
    const service = new CommerceBoxLimitService(
      { axiosRef: { get } } as any,
      config({ billingApiUrl: 'https://commerce.example/api/billing', 'usageExport.token': 'internal-token' }),
    )

    await expect(service.resolveLimit('org-1')).resolves.toEqual({ kind: 'limited', value: 20 })
    await expect(service.resolveLimit('org-1')).resolves.toEqual({ kind: 'limited', value: 20 })
    expect(get).toHaveBeenCalledTimes(4)
  })

  it('does not make anonymous requests or cache a missing-token fallback', async () => {
    const values: Record<string, unknown> = { billingApiUrl: 'https://commerce.example/api/billing' }
    const get = jest.fn((url: string) =>
      Promise.resolve(
        url.includes('/organization/')
          ? { data: { plan: { planId: 'pro' } } }
          : { data: [{ id: 'pro', concurrencyLimit: 100 }] },
      ),
    )
    const service = new CommerceBoxLimitService({ axiosRef: { get } } as any, config(values))

    await expect(service.resolveLimit('org-1')).resolves.toEqual({ kind: 'limited', value: 20 })
    expect(get).not.toHaveBeenCalled()

    values['usageExport.token'] = 'internal-token'
    await expect(service.resolveLimit('org-1')).resolves.toEqual({ kind: 'limited', value: 100 })
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('does not cache a fallback caused by a malformed response', async () => {
    let catalog: unknown = { not: 'a catalog' }
    const get = jest.fn((url: string) =>
      Promise.resolve(
        url.includes('/organization/')
          ? { data: { plan: { planId: 'pro' } } }
          : { data: catalog },
      ),
    )
    const service = new CommerceBoxLimitService(
      { axiosRef: { get } } as any,
      config({ billingApiUrl: 'https://commerce.example/api/billing', 'usageExport.token': 'internal-token' }),
    )

    await expect(service.resolveLimit('org-1')).resolves.toEqual({ kind: 'limited', value: 20 })
    catalog = [{ id: 'pro', concurrencyLimit: 100 }]
    await expect(service.resolveLimit('org-1')).resolves.toEqual({ kind: 'limited', value: 100 })
    expect(get).toHaveBeenCalledTimes(4)
  })

  it('deduplicates concurrent limit resolutions for one organization', async () => {
    let resolveCatalog!: (value: unknown) => void
    let resolveOrganizationPlan!: (value: unknown) => void
    const catalog = new Promise((resolve) => {
      resolveCatalog = resolve
    })
    const organizationPlan = new Promise((resolve) => {
      resolveOrganizationPlan = resolve
    })
    const get = jest.fn((url: string) =>
      url.includes('/organization/') ? organizationPlan : catalog,
    )
    const service = new CommerceBoxLimitService(
      { axiosRef: { get } } as any,
      config({ billingApiUrl: 'https://commerce.example/api/billing', 'usageExport.token': 'internal-token' }),
    )

    const first = service.resolveLimit('org-1')
    const second = service.resolveLimit('org-1')
    expect(get).toHaveBeenCalledTimes(2)

    resolveCatalog({ data: [{ id: 'pro', concurrencyLimit: 100 }] })
    resolveOrganizationPlan({ data: { plan: { planId: 'pro' } } })
    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: 'limited', value: 100 },
      { kind: 'limited', value: 100 },
    ])
  })

  it('expires successful resolutions after ten seconds', async () => {
    jest.useFakeTimers({ now: new Date('2026-08-28T00:00:00Z') })
    const get = jest.fn((url: string) =>
      Promise.resolve(
        url.includes('/organization/')
          ? { data: { plan: { planId: 'pro' } } }
          : { data: [{ id: 'pro', concurrencyLimit: 100 }] },
      ),
    )
    const service = new CommerceBoxLimitService(
      { axiosRef: { get } } as any,
      config({ billingApiUrl: 'https://commerce.example/api/billing', 'usageExport.token': 'internal-token' }),
    )

    await service.resolveLimit('org-1')
    jest.advanceTimersByTime(9_999)
    await service.resolveLimit('org-1')
    expect(get).toHaveBeenCalledTimes(2)

    jest.advanceTimersByTime(1)
    await service.resolveLimit('org-1')
    expect(get).toHaveBeenCalledTimes(4)
  })
})
