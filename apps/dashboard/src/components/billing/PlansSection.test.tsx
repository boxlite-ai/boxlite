// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { AxiosError } from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlansSection } from './PlansSection'

const state = vi.hoisted(() => ({
  owner: true,
  catalog: {
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    data: [
      { id: 'payg', name: 'NoSubscription', priceMonthlyCents: 0, selfServe: true },
      { id: 'team', name: 'Team', priceMonthlyCents: 10000, selfServe: true },
      { id: 'starter', name: 'Go', priceMonthlyCents: 500, selfServe: true },
    ],
  },
  subscription: { isLoading: false, isError: false, refetch: vi.fn(), data: null },
  eligibility: {
    isSuccess: true,
    isFetching: false,
    isError: false,
    error: null as Error | null,
    refetch: vi.fn(),
    data: [
      { name: 'Go', eligible: true, durationSeconds: 259200 },
      { name: 'Team', eligible: false, durationSeconds: 0 },
      { name: 'Enterprise', eligible: false, durationSeconds: 0 },
    ],
  },
  signinRedirect: vi.fn(),
}))
vi.mock('react-oidc-context', () => ({ useAuth: () => ({ signinRedirect: state.signinRedirect }) }))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: 'org' },
    authenticatedUserOrganizationMember: { role: state.owner ? 'owner' : 'member' },
  }),
}))
vi.mock('@/hooks/queries/usePlansQuery', () => ({ usePlansQuery: () => state.catalog }))
vi.mock('@/hooks/queries/billingQueries', () => ({
  useOwnerPlanQuery: () => state.subscription,
  useOwnerTrialEligibilityQuery: () => state.eligibility,
}))
let root: Root
function render() {
  const host = document.createElement('div')
  document.body.append(host)
  act(() => {
    root = createRoot(host)
    root.render(
      <MemoryRouter initialEntries={['/dashboard/billing?tab=plans']}>
        <PlansSection />
      </MemoryRouter>,
    )
  })
  return host
}
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  state.owner = true
  state.catalog.isLoading = false
  state.catalog.isError = false
  state.subscription.isError = false
  state.eligibility.isSuccess = true
  state.eligibility.isFetching = false
  state.eligibility.isError = false
  state.eligibility.error = null
  vi.clearAllMocks()
})
afterEach(() => {
  act(() => root?.unmount())
  document.body.innerHTML = ''
})
describe('Plans section states', () => {
  it('matches each trial offer to its catalogue name', () => {
    const host = render()
    const row = [...host.querySelectorAll('tr')].find(
      (tr) => tr.querySelector('th')?.textContent === 'Trial eligibility',
    )!
    expect(row.cells[2].textContent).toBe('Not eligible')
    expect(row.cells[4].textContent).toBe('Not eligible')
    expect(host.querySelectorAll('thead th')[3].textContent).toContain('Free Trial 3 Days')
    expect(host.querySelectorAll('thead th')[2].textContent).not.toContain('Free Trial')
  })
  it('keeps the comparison available while fresh eligibility is pending', () => {
    state.eligibility.isFetching = true
    const host = render()
    expect(host.querySelector('thead')?.textContent).not.toContain('Free Trial')
    expect(host.textContent).toContain('Checking eligibility')
    expect(host.textContent).not.toContain('Not eligible')
  })
  it.each([401, 403, 503])('handles eligibility HTTP %i without presenting a trial decision', (status) => {
    const cause = new AxiosError('Request failed')
    Object.assign(cause, { response: { status } })
    state.eligibility.error = new Error('Request failed', { cause })
    state.eligibility.isError = true
    state.eligibility.isSuccess = false
    const host = render()
    const notice = host.querySelector('[role="alert"]')!
    expect(host.querySelector('table')).not.toBeNull()
    expect(host.textContent).not.toContain('Not eligible')
    expect(host.querySelector('thead')?.textContent).not.toContain('Free Trial')
    if (status === 403) {
      expect(notice.textContent).toContain('organization owner')
      expect(notice.querySelector('button')).toBeNull()
    } else {
      act(() => notice.querySelector('button')!.click())
      if (status === 401)
        expect(state.signinRedirect).toHaveBeenCalledWith({ state: { returnTo: '/dashboard/billing?tab=plans' } })
      else expect(state.eligibility.refetch).toHaveBeenCalledOnce()
    }
  })
  it('shows a loading surface instead of an empty comparison during catalogue loading', () => {
    state.catalog.isLoading = true
    const host = render()
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Loading plans')
    expect(host.querySelector('table')).toBeNull()
  })
  it('retries both owner queries after an error', () => {
    state.catalog.isError = true
    const host = render()
    act(() => host.querySelector('button')!.click())
    expect(state.catalog.refetch).toHaveBeenCalledOnce()
    expect(state.subscription.refetch).toHaveBeenCalledOnce()
  })
  it('lets members compare public plans without using owner subscription errors or enabling changes', () => {
    state.owner = false
    state.subscription.isError = true
    const host = render()
    expect(host.querySelector('table')).not.toBeNull()
    expect(host.textContent).toContain('Ask your organization owner')
    expect(host.querySelector('thead')?.textContent).not.toContain('Free Trial')
    expect(host.querySelector('thead button')?.disabled).toBe(true)
    expect(host.querySelector('a[href="https://boxlite.ai/contact"]')).not.toBeNull()
  })
})
