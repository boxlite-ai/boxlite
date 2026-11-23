// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BoxPriceSummary } from './BoxPriceSummary'
import type { OrganizationPlan } from '@/billing-api'
const state = vi.hoisted(() => ({
  owner: true,
  catalog: {
    isSuccess: true,
    isError: false,
    isPlaceholderData: false,
    data: [{ id: 'starter', name: 'Starter', priceMonthlyCents: 500, includedQuotaCents: 2000, selfServe: true }],
  },
  subscription: { isSuccess: true, isError: false, isPlaceholderData: false, data: null as OrganizationPlan | null },
}))
vi.mock('@/hooks/queries/usePlansQuery', () => ({ usePlansQuery: () => state.catalog }))
vi.mock('@/hooks/queries/billingQueries', () => ({ useOwnerPlanQuery: () => state.subscription }))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    authenticatedUserOrganizationMember: { role: state.owner ? 'owner' : 'member' },
  }),
}))
let root: Root
let host: HTMLDivElement
function render(currency = 'USD') {
  act(() =>
    root.render(
      <BoxPriceSummary
        quote={{ totalCents: 6.66, lines: [] }}
        spec={{ cpu: 1, memory: 1, disk: 10 }}
        currency={currency}
      />,
    ),
  )
  return host.textContent!
}
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  state.owner = true
  state.subscription = { isSuccess: true, isError: false, isPlaceholderData: false, data: null }
  state.catalog.isSuccess = true
  state.catalog.isError = false
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
})
describe('Box subscription summary', () => {
  it('keeps PAYG primary and links plans in another tab without initiating checkout', () => {
    expect(render()).toContain('PAYG estimate$0.0666')
    expect(host.textContent).toContain('75% lower effective hourly cost with a subscription')
    expect(host.textContent).not.toContain('4× included usage per dollar')
    expect(host.querySelector('a')?.target).toBe('_blank')
    expect(host.querySelector('a')?.getAttribute('href')).toBe('/dashboard/billing?tab=plans')
  })
  it('keeps PAYG primary for subscribed users too', () => {
    state.subscription.data = {
      planId: 'starter',
      planName: 'Starter',
      status: 'active',
      cycleFrom: new Date(Date.now() - 10000),
      cycleTo: new Date(Date.now() + 86400000),
      includedQuotaCents: 2000,
      quotaConsumedCents: 100,
      quotaRemainingCents: 1900,
    }
    expect(render()).toContain('PAYG estimate$0.0666')
    expect(host.textContent).toContain('75% lower effective hourly cost with a subscription')
  })
  it.each(['loading', 'error', 'placeholder', 'member', 'currency', 'catalog-error'])(
    'does not infer a subscription benefit from %s',
    (scenario) => {
      if (scenario === 'loading') state.subscription.isSuccess = false
      if (scenario === 'error') state.subscription.isError = true
      if (scenario === 'placeholder') state.subscription.isPlaceholderData = true
      if (scenario === 'member') state.owner = false
      if (scenario === 'catalog-error') state.catalog.isError = true
      const text = render(scenario === 'currency' ? 'EUR' : 'USD')
      expect(text).not.toContain('effective')
      expect(text).not.toContain('4×')
      expect(text).toContain('PAYG estimate')
    },
  )
})
