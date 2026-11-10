// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { type OrganizationPlan, type OrganizationWallet, type Plan } from '@/billing-api'
import { CycleOverview } from './CycleOverview'
import { PlanCards } from './PlanCards'

vi.mock('@/hooks/queries/useUsagePricesQuery', () => ({ useUsagePricesQuery: () => ({ data: undefined }) }))
const wallet: OrganizationWallet = {
  name: 'Test',
  balanceCents: 2000,
  ongoingBalanceCents: 1000,
  creditCardConnected: true,
}
const catalog: Plan[] = [
  {
    id: 'starter',
    name: 'Starter',
    priceMonthlyCents: 1900,
    includedQuotaCents: 3000,
    concurrencyLimit: 20,
    selfServe: true,
  },
  {
    id: 'pro',
    name: 'Pro',
    priceMonthlyCents: 14900,
    includedQuotaCents: 25000,
    concurrencyLimit: 100,
    selfServe: true,
  },
  {
    id: 'max',
    name: 'Max',
    priceMonthlyCents: 49900,
    includedQuotaCents: 90000,
    concurrencyLimit: 1000,
    selfServe: true,
  },
]
const plan: OrganizationPlan = {
  planId: 'pro',
  planName: 'Pro',
  status: 'active',
  cycleFrom: new Date('2026-08-01'),
  cycleTo: new Date('2026-09-01'),
  includedQuotaCents: 25000,
  quotaConsumedCents: 6250,
  quotaRemainingCents: 18750,
}
let root: Root | undefined
beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})
afterEach(() => {
  act(() => root?.unmount())
  document.body.innerHTML = ''
})
function render(content: ReactNode) {
  const host = document.createElement('div')
  document.body.append(host)
  act(() => {
    root = createRoot(host)
    root.render(content)
  })
  return host
}
function RouteProbe() {
  return <output>{useLocation().pathname}</output>
}

describe('billing surface contracts', () => {
  it('keeps plan price, consumed quota and wallet distinct in the compact summary', () => {
    const host = render(<CycleOverview wallet={wallet} organizationPlan={plan} catalogPlan={catalog[1]} />)
    expect(host.textContent).toContain('Pro$149/mo')
    expect(host.textContent).toContain('Wallet balance$10.00')
    expect(host.textContent).toContain('Quota consumed$62.50/ $250.00')
    expect(host.textContent).not.toContain('no subscription')
  })
  it('shows grant progress across the summary width and retains plan guidance', () => {
    const host = render(
      <CycleOverview
        wallet={{ ...wallet, creditGrantedCents: 10000, creditRemainingCents: 6000 }}
        plansAnchorId="plans"
      />,
    )
    expect(host.textContent).toContain('Free credits left$60.00of $100.00 granted')
    expect(host.textContent).toContain('Credits used$40.00 / $100.00')
    expect(host.querySelector('a[href="#plans"]')).not.toBeNull()
    const creditLabel = [...host.querySelectorAll('span')].find((node) => node.textContent === 'Credits used')!
    expect(creditLabel.parentElement?.parentElement?.classList.contains('lg:col-span-2')).toBe(true)
  })
  it('shows wallet-funded usage without claiming a subscription or grant', () => {
    const host = render(<CycleOverview wallet={wallet} />)
    expect(host.textContent).toContain('Pay as you gono subscription')
    expect(host.textContent).toContain('Uninvoiced usage$10.00')
    expect(host.textContent).not.toContain('Free credits left')
  })
  it('keeps current plan disabled and routes upgrade and downgrade to confirmation', () => {
    const host = render(
      <MemoryRouter>
        <PlanCards plans={catalog} organizationPlan={plan} />
        <RouteProbe />
      </MemoryRouter>,
    )
    const buttons = [...host.querySelectorAll('button')]
    expect(buttons.find((button) => button.textContent === 'Current plan')?.disabled).toBe(true)
    act(() => buttons.find((button) => button.textContent?.includes('Upgrade'))!.click())
    expect(host.querySelector('output')?.textContent).toBe('/dashboard/billing/plan/max')
    act(() => buttons.find((button) => button.textContent?.includes('Downgrade'))!.click())
    expect(host.querySelector('output')?.textContent).toBe('/dashboard/billing/plan/starter')
    expect(host.querySelector('a[href^="mailto:sales@boxlite.ai"]')?.textContent).toContain('Contact sales')
  })
})
