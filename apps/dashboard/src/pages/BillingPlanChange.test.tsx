// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import BillingPlanChange from './BillingPlanChange'
const mock = vi.hoisted(() => ({
  upgrade: vi.fn(),
  refetch: vi.fn(),
  card: true,
  fetching: false,
  error: false,
  membership: 'ready',
  placeholder: false,
}))
vi.mock('react-oidc-context', () => ({ useAuth: () => ({ user: { profile: { sub: 'user' } } }) }))
vi.mock('@/hooks/useConfig', () => ({ useConfig: () => ({ billingApiUrl: 'mock' }) }))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: 'org', name: 'Org' },
    organizationMembers: [{}],
    organizationMembersStatus: mock.membership,
    authenticatedUserOrganizationMember: { role: 'owner' },
  }),
}))
vi.mock('@/hooks/queries/billingQueries', () => ({
  useOwnerPlanQuery: () => ({
    data: null,
    isSuccess: true,
    isError: false,
    isFetching: mock.fetching,
    isPlaceholderData: mock.placeholder,
    refetch: mock.refetch,
  }),
  useOwnerWalletQuery: () => ({
    data: { creditCardConnected: mock.card, balanceCents: 0 },
    isSuccess: !mock.error,
    isError: mock.error,
    isFetching: mock.fetching,
    isPlaceholderData: mock.placeholder,
    refetch: mock.refetch,
  }),
}))
vi.mock('@/hooks/queries/usePlansQuery', () => ({
  usePlansQuery: () => ({
    data: [
      {
        id: 'pro',
        name: 'Starter',
        priceMonthlyCents: 500,
        includedQuotaCents: 2000,
        concurrencyLimit: 4,
        selfServe: true,
      },
    ],
    isSuccess: true,
    isFetching: mock.fetching,
    isPlaceholderData: mock.placeholder,
    refetch: mock.refetch,
  }),
}))
vi.mock('@/hooks/mutations/useUpgradePlanMutation', () => ({
  useUpgradePlanMutation: () => ({ mutateAsync: mock.upgrade, isPending: false }),
}))
vi.mock('@/hooks/mutations/useDowngradePlanMutation', () => ({
  useDowngradePlanMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))
let root: ReturnType<typeof createRoot>, host: HTMLDivElement
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  Object.assign(mock, { card: true, fetching: false, error: false, membership: 'ready', placeholder: false })
  mock.refetch.mockResolvedValue({})
  mock.upgrade.mockResolvedValue(undefined)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})
async function render() {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/dashboard/billing/plan/pro?setup=return']}>
        <Routes>
          <Route path="/dashboard/billing/plan/:planId" element={<BillingPlanChange />} />
          <Route path="/dashboard/billing" element={<p>Billing destination</p>} />
        </Routes>
      </MemoryRouter>,
    )
    await new Promise((r) => setTimeout(r, 0))
  })
}
it('restores confirmation after card setup without automatically submitting', async () => {
  await render()
  expect(host.textContent).toContain('Card added. Confirm your plan.')
  expect(mock.refetch).toHaveBeenCalledTimes(3)
  expect(mock.upgrade).not.toHaveBeenCalled()
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Confirm subscription')!
  await act(async () => button.click())
  expect(mock.upgrade).toHaveBeenCalledExactlyOnceWith({ organizationId: 'org', planId: 'pro' })
})
it('does not enable subscription when card setup was canceled', async () => {
  mock.card = false
  await render()
  expect(host.textContent).toContain('Card setup is not confirmed yet.')
  expect([...host.querySelectorAll('button')].find((b) => b.textContent === 'Confirm subscription')?.disabled).toBe(
    true,
  )
  expect(mock.upgrade).not.toHaveBeenCalled()
})
it('does not offer confirmation while fresh reads are pending or fail', async () => {
  mock.fetching = true
  await render()
  expect(host.textContent).not.toContain('Confirm subscription')
  mock.fetching = false
  mock.error = true
  await render()
  expect(host.textContent).toContain('There was an error loading billing data.')
  expect(mock.upgrade).not.toHaveBeenCalled()
})

it('waits for current organization membership and rejects placeholder billing data', async () => {
  mock.membership = 'loading'
  await render()
  expect(host.textContent).not.toContain('Confirm subscription')
  expect(mock.refetch).not.toHaveBeenCalled()
  mock.membership = 'ready'
  mock.placeholder = true
  await render()
  expect(host.textContent).not.toContain('Confirm subscription')
  expect(mock.upgrade).not.toHaveBeenCalled()
})
