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

describe('getOrganizationTier subscription hydration', () => {
  it('turns the cycle bounds into Dates and passes the quota fields through', async () => {
    const api = serve({
      tier: 2,
      largestSuccessfulPaymentCents: 2500,
      hasVerifiedBusinessEmail: true,
      subscription: {
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
    const tier = await api.getOrganizationTier('org-1')
    expect(tier.subscription?.cycleFrom).toEqual(new Date('2026-08-05T00:00:00.000Z'))
    expect(tier.subscription?.cycleTo).toEqual(new Date('2026-09-05T00:00:00.000Z'))
    expect(tier.subscription).toMatchObject({
      planId: 'pro',
      includedQuotaCents: 25000,
      quotaConsumedCents: 6250,
      quotaRemainingCents: 18750,
    })
  })

  it('leaves the block absent for an unsubscribed organization', async () => {
    const api = serve({ tier: 1, largestSuccessfulPaymentCents: 0, hasVerifiedBusinessEmail: true })
    const tier = await api.getOrganizationTier('org-1')
    expect(tier.subscription).toBeUndefined()
    expect(tier).not.toHaveProperty('subscription')
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
