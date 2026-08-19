import { afterEach, describe, expect, it } from 'vitest'
import axios from 'axios'
import { BillingApiClient } from './billingApiClient'

// The api/apiClient.test.ts trick: a custom adapter settles every request
// locally, so the wire mapping is exercised without a server. Each test sets
// the JSON the "server" returns and reads back what URL was requested.
let requestedUrl = ''
function serve(data: unknown): BillingApiClient {
  axios.defaults.adapter = (async (cfg: { url?: string; baseURL?: string }) => {
    requestedUrl = `${cfg.baseURL ?? ''}${cfg.url ?? ''}`
    return { data, status: 200, statusText: 'OK', headers: {}, config: cfg }
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
