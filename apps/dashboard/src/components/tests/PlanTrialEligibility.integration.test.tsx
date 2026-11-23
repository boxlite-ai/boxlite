// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { keepPreviousData, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import axios from 'axios'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import { BillingApiClient, type PlanTrialEligibility } from '@/billing-api'
import { PlansSection } from '../billing/PlansSection'

const scope = vi.hoisted(() => ({ organizationId: 'a', subject: 'first', role: 'member' }))
let billingApi: BillingApiClient
vi.mock('@/hooks/useApi', () => ({ useApi: () => ({ billingApi }) }))
vi.mock('@/hooks/useConfig', () => ({ useConfig: () => ({ billingApiUrl: '/billing' }) }))
vi.mock('react-oidc-context', () => ({ useAuth: () => ({ user: { profile: { sub: scope.subject } } }) }))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: scope.organizationId },
    authenticatedUserOrganizationMember: { role: scope.role },
  }),
}))

it('isolates trial ribbons by owner and organization through delayed responses', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const offers = (durationSeconds: number) => [{ name: 'Go', eligible: true, durationSeconds }]
  const pending = Promise.withResolvers<PlanTrialEligibility[]>()
  const lookup = vi
    .fn()
    .mockResolvedValueOnce(offers(259200))
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce(offers(5400))
  const originalAdapter = axios.defaults.adapter
  axios.defaults.adapter = async (config) => {
    let data: unknown = {}
    if (config.url === '/plan') data = [{ id: 'starter', name: 'Go', priceMonthlyCents: 500, selfServe: true }]
    if (config.url?.endsWith('/trial-eligibility'))
      data = { plans: await lookup(config.url, config.headers.Authorization) }
    return { status: 200, statusText: 'OK', data, headers: {}, config }
  }
  billingApi = new BillingApiClient('/billing', 'first-token')
  const client = new QueryClient({ defaultOptions: { queries: { placeholderData: keepPreviousData } } })
  const host = document.createElement('div')
  const root = createRoot(host)
  const render = () =>
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <PlansSection />
          </MemoryRouter>
        </QueryClientProvider>,
      ),
    )
  const waitForText = (expected: string) =>
    vi.waitFor(async () => {
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
      expect(host.textContent).toContain(expected)
    })
  const ribbon = () => host.querySelector('.plan-trial-ribbon')?.textContent
  try {
    render()
    await waitForText('Owner managed')
    expect(lookup).not.toHaveBeenCalled()
    scope.role = 'owner'
    render()
    await waitForText('Free Trial 3 Days')
    scope.organizationId = 'b'
    render()
    expect(ribbon()).toBeUndefined()
    scope.subject = 'second'
    billingApi.setAccessToken('second-token')
    render()
    await waitForText('Free Trial 1h 30m')
    await act(async () => pending.resolve(offers(60)))
    expect(ribbon()).toBe('Free Trial 1h 30m')
    expect(lookup.mock.calls).toEqual([
      ['/organization/a/plan/trial-eligibility', 'Bearer first-token'],
      ['/organization/b/plan/trial-eligibility', 'Bearer first-token'],
      ['/organization/b/plan/trial-eligibility', 'Bearer second-token'],
    ])
  } finally {
    act(() => root.unmount())
    client.clear()
    axios.defaults.adapter = originalAdapter
  }
})
