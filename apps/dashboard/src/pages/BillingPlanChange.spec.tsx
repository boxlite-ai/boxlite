// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import BillingPlanChange from './BillingPlanChange'
import { consumePlanSetup, savePlanSetup } from '@/components/billing/planSetupIntent'
const mock = vi.hoisted(() => ({
  upgrade: vi.fn(),
  errorHandler: vi.fn(),
  refreshMembers: vi.fn(),
  org: 'org',
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
    selectedOrganization: { id: mock.org, name: 'Org' },
    organizationMembers: [{}],
    organizationMembersStatus: mock.membership,
    refreshOrganizationMembers: mock.refreshMembers,
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
vi.mock('@/lib/error-handling', () => ({ handleApiError: mock.errorHandler }))
let root: ReturnType<typeof createRoot>, host: HTMLDivElement
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  sessionStorage.clear()
  mock.org = 'org'
  Object.assign(mock, { card: true, fetching: false, error: false, membership: 'ready', placeholder: false })
  mock.refetch.mockResolvedValue({})
  mock.refreshMembers.mockResolvedValue(undefined)
  mock.upgrade.mockResolvedValue(undefined)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})
async function render(path = '/dashboard/billing/plan/pro?setup=return') {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
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

async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  expect(button).toBeDefined()
  await act(async () => button!.click())
}
it('saves the exact plan before card setup and exposes recovery when navigation does not leave', async () => {
  mock.card = false
  mock.upgrade.mockResolvedValue('#checkout')
  await render('/dashboard/billing/plan/pro')
  await click('Verify card to continue')
  expect(consumePlanSetup('user', 'org')).toBe('pro')
  expect(host.querySelector('a[href="#checkout"]')).not.toBeNull()
  expect(host.textContent).toContain('Redirecting to Stripe')
  await click('Back to Billing')
  expect(host.textContent).toContain('Billing destination')
})
it('does not save card setup intent for an already connected card checkout', async () => {
  mock.upgrade.mockResolvedValue('#checkout')
  await render('/dashboard/billing/plan/pro')
  await click('Subscribe')
  expect(consumePlanSetup('user', 'org')).toBeNull()
  expect(host.querySelector('a[href="#checkout"]')).not.toBeNull()
})
it('keeps checkout accessible when session storage is unavailable', async () => {
  mock.card = false
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('blocked')
  })
  mock.upgrade.mockResolvedValue('#checkout')
  await render('/dashboard/billing/plan/pro')
  await click('Verify card to continue')
  expect(host.textContent).toContain('Your browser could not save the selection')
  expect(host.querySelector('a[href="#checkout"]')).not.toBeNull()
})
it('refreshes the card status without submitting when setup is incomplete', async () => {
  mock.card = false
  await render()
  await click('Check card status')
  expect(mock.refetch).toHaveBeenCalledTimes(4)
  expect(mock.upgrade).not.toHaveBeenCalled()
})
it('retries all billing reads on query errors', async () => {
  mock.error = true
  await render()
  await click('Retry')
  expect(mock.refetch).toHaveBeenCalledTimes(6)
})
it('header back discards only the current account organization selection', async () => {
  savePlanSetup('user', 'org', 'pro')
  savePlanSetup('user', 'other', 'max')
  await render()
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Back to Billing"]')!.click())
  expect(consumePlanSetup('user', 'org')).toBeNull()
  expect(consumePlanSetup('user', 'other')).toBe('max')
  expect(host.textContent).toContain('Billing destination')
})
it('reports a failed explicit subscription without leaving the confirmation', async () => {
  const error = Error('request failed')
  mock.upgrade.mockRejectedValue(error)
  await render()
  await click('Confirm subscription')
  expect(mock.errorHandler).toHaveBeenCalledWith(error, 'Failed to upgrade organization plan')
  expect(host.textContent).toContain('Confirm subscription')
})
it.each(['resolve', 'reject', 'return-to-origin'])(
  'ignores a late %s after the organization changes',
  async (outcome) => {
    let resolve!: (value: string) => void
    let reject!: (reason: Error) => void
    mock.upgrade.mockImplementation(
      () =>
        new Promise((yes, no) => {
          resolve = yes
          reject = no
        }),
    )
    await render()
    await click('Confirm subscription')
    mock.org = 'other'
    await render()
    if (outcome === 'return-to-origin') {
      mock.org = 'org'
      await render()
    }
    await act(async () => (outcome !== 'reject' ? resolve('#checkout') : reject(Error('late'))))
    expect(host.textContent).toContain('Confirm subscription')
    expect(host.querySelector('a[href="#checkout"]')).toBeNull()
    expect(consumePlanSetup('user', 'org')).toBeNull()
    expect(mock.errorHandler).not.toHaveBeenCalled()
  },
)

it('offers membership retry instead of an endless skeleton after permission lookup fails', async () => {
  mock.membership = 'error'
  await render()
  expect(host.textContent).toContain('Could not verify billing permissions')
  await click('Retry permissions')
  expect(mock.refreshMembers).toHaveBeenCalledOnce()
  expect(mock.upgrade).not.toHaveBeenCalled()
})
