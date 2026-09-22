// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import Billing from './Billing'

const fixture = vi.hoisted(() => ({
  role: 'member',
  billingUrl: 'https://commerce.test',
  billing: { getOrganizationWallet: vi.fn(), getOrganizationPlan: vi.fn(), listPlans: vi.fn() },
  organizations: { getOrganizationReferralCode: vi.fn() },
}))
vi.mock('@/hooks/useApi', () => ({
  useApi: () => ({ billingApi: fixture.billing, organizationsApi: fixture.organizations }),
}))
vi.mock('@/hooks/useConfig', () => ({ useConfig: () => ({ billingApiUrl: fixture.billingUrl }) }))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: 'org-1', name: 'Selected organization' },
    authenticatedUserOrganizationMember: { role: fixture.role },
  }),
}))
vi.mock('react-oidc-context', () => ({ useAuth: () => ({ user: { profile: { email_verified: true } } }) }))

describe('F01 Billing overview shares independently of owner wallet/plan queries', () => {
  let root: Root, host: HTMLDivElement, client: QueryClient
  const flush = async () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    fixture.role = 'member'
    fixture.billingUrl = 'https://commerce.test'
    fixture.billing.getOrganizationWallet.mockReset().mockRejectedValue(new Error('Wallet unavailable'))
    fixture.billing.getOrganizationPlan.mockReset().mockRejectedValue(new Error('Plan unavailable'))
    fixture.billing.listPlans.mockReset().mockResolvedValue([])
    fixture.organizations.getOrganizationReferralCode
      .mockReset()
      .mockResolvedValue({ data: { organizationId: 'org-1', referralCode: 'ABCD2345EF' } })
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    client.clear()
    host.remove()
  })
  async function mount() {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <Billing />
          </MemoryRouter>
        </QueryClientProvider>,
      ),
    )
    await flush()
  }
  it('a member can share without querying owner wallet or plan endpoints', async () => {
    await mount()
    expect(host.textContent).toContain('ABCD2345EF')
    expect(fixture.billing.getOrganizationWallet).not.toHaveBeenCalled()
    expect(fixture.billing.getOrganizationPlan).not.toHaveBeenCalled()
  })
  it('an owner can still share while wallet and plan requests fail', async () => {
    fixture.role = 'owner'
    await mount()
    expect(host.textContent).toContain('ABCD2345EF')
    expect(host.textContent).toContain('error loading billing data')
    expect(fixture.billing.getOrganizationWallet).toHaveBeenCalled()
  })
  it('sharing remains available when the public Commerce API is unconfigured', async () => {
    fixture.billingUrl = ''
    await mount()
    expect(host.textContent).toContain('ABCD2345EF')
    expect(fixture.billing.getOrganizationWallet).not.toHaveBeenCalled()
    expect(fixture.billing.listPlans).not.toHaveBeenCalled()
  })
  it('a member retry after catalog failure preserves owner-only request boundaries', async () => {
    fixture.billing.listPlans.mockRejectedValueOnce(new Error('Catalog unavailable')).mockResolvedValue([])
    await mount()
    const retry = [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Retry')!
    expect(retry).toBeTruthy()
    await act(async () => retry.click())
    await flush()
    expect(fixture.billing.getOrganizationWallet).not.toHaveBeenCalled()
    expect(fixture.billing.getOrganizationPlan).not.toHaveBeenCalled()
    expect(fixture.billing.listPlans).toHaveBeenCalledTimes(2)
  })
})
