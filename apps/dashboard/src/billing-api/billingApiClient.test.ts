import { afterEach, describe, expect, it } from 'vitest'
import axios from 'axios'
import { BillingApiClient } from './billingApiClient'

// The api/apiClient.test.ts trick: a custom adapter settles every request
// locally, so the wire mapping is exercised without a server. Each test sets
// the JSON the "server" returns and reads back what URL was requested.
let requestedUrl = ''
let requestedUrls: string[] = []
let requestedMethod = ''
let requestedData: unknown
function serve(data: unknown | ((url: string) => unknown)): BillingApiClient {
  requestedUrls = []
  axios.defaults.adapter = (async (cfg: { url?: string; baseURL?: string; method?: string; data?: unknown }) => {
    requestedUrl = `${cfg.baseURL ?? ''}${cfg.url ?? ''}`
    requestedUrls.push(requestedUrl)
    requestedMethod = cfg.method ?? ''
    requestedData = cfg.data
    const responseData = typeof data === 'function' ? data(requestedUrl) : data
    return { data: responseData, status: 200, statusText: 'OK', headers: {}, config: cfg }
  }) as never
  return new BillingApiClient('http://billing.test/api/billing', 'tok')
}

afterEach(() => {
  axios.defaults.adapter = undefined as never
})

describe('getOrganizationPlan', () => {
  it('unwraps the plan envelope and turns the cycle bounds into Dates', async () => {
    const api = serve({
      plan: {
        planId: 'pro',
        planName: 'Pro',
        status: 'active',
        cycleFrom: '2026-08-05T00:00:00.000Z',
        cycleTo: '2026-09-05T00:00:00.000Z',
        includedQuotaCents: 25000,
        quotaConsumedCents: 6250,
        quotaRemainingCents: 18750,
      },
    })
    const plan = await api.getOrganizationPlan('org-1')
    expect(plan?.cycleFrom).toEqual(new Date('2026-08-05T00:00:00.000Z'))
    expect(plan?.cycleTo).toEqual(new Date('2026-09-05T00:00:00.000Z'))
    expect(plan).toMatchObject({
      planId: 'pro',
      includedQuotaCents: 25000,
      quotaConsumedCents: 6250,
      quotaRemainingCents: 18750,
    })
  })

  it('hydrates dueAt when the plan is past due', async () => {
    const api = serve({
      plan: {
        planId: 'pro',
        planName: 'Pro',
        status: 'past_due',
        cycleFrom: '2026-08-05T00:00:00.000Z',
        cycleTo: '2026-09-05T00:00:00.000Z',
        includedQuotaCents: 25000,
        quotaConsumedCents: 6250,
        quotaRemainingCents: 18750,
        dueAt: '2026-08-20T00:00:00.000Z',
        amountDueCents: 14900,
      },
    })
    const plan = await api.getOrganizationPlan('org-1')
    expect(plan?.dueAt).toEqual(new Date('2026-08-20T00:00:00.000Z'))
  })

  it('returns null for an organization with no live plan (the {} envelope, not a bare null)', async () => {
    const api = serve({})
    const plan = await api.getOrganizationPlan('org-1')
    expect(plan).toBeNull()
  })
})

describe('upgradePlan', () => {
  it('returns the checkout URL when a first subscribe needs one', async () => {
    const api = serve({ url: 'https://checkout.stripe.com/pay/cs_test_123' })
    const url = await api.upgradePlan('org-1', 'pro')
    expect(url).toBe('https://checkout.stripe.com/pay/cs_test_123')
  })

  it('returns undefined when an in-place change applies with no redirect', async () => {
    const api = serve(undefined)
    const url = await api.upgradePlan('org-1', 'max')
    expect(url).toBeUndefined()
  })
})

describe('withdrawPendingPlan', () => {
  it('deletes the queued plan without resubmitting the effective plan', async () => {
    const api = serve(undefined)

    await api.withdrawPendingPlan('org-1')

    expect(requestedMethod).toBe('delete')
    expect(requestedUrl).toBe('http://billing.test/api/billing/organization/org-1/plan/pending')
    expect(requestedData).toBeUndefined()
  })
})

describe('listAllPaymentMethods', () => {
  it('walks every page and returns every stored method', async () => {
    const firstPageMethod = {
      id: 'card-1',
      isDefault: true,
      paymentProviderType: 'stripe',
      providerMethodId: 'pm_1',
      details: { brand: 'visa', last4: '4242', expMonth: 8, expYear: 2027 },
    }
    const secondPageMethod = {
      id: 'card-2',
      isDefault: false,
      paymentProviderType: 'stripe',
      providerMethodId: 'pm_2',
      details: { brand: 'mastercard', last4: '4444', expMonth: 12, expYear: 2029 },
    }
    const api = serve((url) =>
      url.endsWith('?page=1&perPage=100')
        ? {
            paymentMethods: [firstPageMethod],
            meta: { currentPage: 1, totalPages: 2, totalCount: 2, nextPage: 2, prevPage: null },
          }
        : {
            paymentMethods: [secondPageMethod],
            meta: { currentPage: 2, totalPages: 2, totalCount: 2, nextPage: null, prevPage: 1 },
          },
    )

    await expect(api.listAllPaymentMethods('org-1')).resolves.toEqual([firstPageMethod, secondPageMethod])
    expect(requestedUrls).toEqual([
      'http://billing.test/api/billing/organization/org-1/payment-methods?page=1&perPage=100',
      'http://billing.test/api/billing/organization/org-1/payment-methods?page=2&perPage=100',
    ])
  })
})

describe('topUpWallet', () => {
  it('posts the amount and returns the hosted payment URL', async () => {
    const payment = { url: 'https://checkout.stripe.com/pay/cs_top_up' }
    const api = serve(payment)

    await expect(api.topUpWallet('org-without-card', 10_000)).resolves.toEqual(payment)
    expect(requestedMethod).toBe('post')
    expect(requestedUrl).toBe('http://billing.test/api/billing/organization/org-without-card/wallet/top-up')
    expect(JSON.parse(String(requestedData))).toEqual({ amountCents: 10_000 })
  })
})

describe('getUsageFundingSeries', () => {
  it('sends granularity and ISO bounds, and maps bucket bounds to Dates', async () => {
    const api = serve([
      {
        from: '2026-08-13T00:00:00.000Z',
        to: '2026-08-14T00:00:00.000Z',
        quotaCoveredCents: 2985,
        fromWalletCents: 15,
      },
    ])
    const from = new Date('2026-07-15T00:00:00.000Z')
    const to = new Date('2026-08-14T00:00:00.000Z')
    const buckets = await api.getUsageFundingSeries('org-1', 'day', from, to)

    expect(requestedUrl).toBe(
      'http://billing.test/api/billing/organization/org-1/usage/series' +
        '?granularity=day&from=2026-07-15T00%3A00%3A00.000Z&to=2026-08-14T00%3A00%3A00.000Z',
    )
    expect(buckets).toEqual([
      {
        from: new Date('2026-08-13T00:00:00.000Z'),
        to: new Date('2026-08-14T00:00:00.000Z'),
        quotaCoveredCents: 2985,
        fromWalletCents: 15,
      },
    ])
  })
})

describe('PR 829 real-data parity: settlement invoices', () => {
  it('keeps only the read surface that current Commerce supports', async () => {
    const response = {
      items: [
        {
          id: 'invoice-1',
          number: 'INV-000001',
          sequentialId: 1,
          chargedAt: '2026-08-18T12:00:00.000Z',
          totalAmountCents: 1_250,
          quotaCoveredCents: 1_000,
          voided: false,
        },
      ],
      totalItems: 1,
      totalPages: 1,
    }
    const api = serve(response)

    await expect(api.listInvoices('org-1', 2, 25)).resolves.toEqual(response)
    expect(requestedUrl).toBe('http://billing.test/api/billing/organization/org-1/invoices?page=2&perPage=25')
    expect(api).not.toHaveProperty('createInvoicePaymentUrl')
    expect(api).not.toHaveProperty('voidInvoice')
  })
})
