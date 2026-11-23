// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlansSection } from './PlansSection'

const state = vi.hoisted(() => ({
  owner: true,
  catalog: {
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    data: [{ id: 'payg', name: 'NoSubscription', priceMonthlyCents: 0, selfServe: true }],
  },
  subscription: { isLoading: false, isError: false, refetch: vi.fn(), data: null },
}))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: 'org' },
    authenticatedUserOrganizationMember: { role: state.owner ? 'owner' : 'member' },
  }),
}))
vi.mock('@/hooks/queries/usePlansQuery', () => ({ usePlansQuery: () => state.catalog }))
vi.mock('@/hooks/queries/billingQueries', () => ({ useOwnerPlanQuery: () => state.subscription }))
let root: Root
function render() {
  const host = document.createElement('div')
  document.body.append(host)
  act(() => {
    root = createRoot(host)
    root.render(
      <MemoryRouter>
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
  vi.clearAllMocks()
})
afterEach(() => {
  act(() => root?.unmount())
  document.body.innerHTML = ''
})
describe('Plans section states', () => {
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
    expect(host.querySelector('thead button')?.disabled).toBe(true)
    expect(host.querySelector('a[href="https://boxlite.ai/contact"]')).not.toBeNull()
  })
})
