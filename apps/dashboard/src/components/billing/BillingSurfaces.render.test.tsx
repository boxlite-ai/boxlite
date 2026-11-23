// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { type OrganizationPlan, type OrganizationWallet, type Plan } from '@/billing-api'
import { CycleOverview } from './CycleOverview'
import { PlanComparison } from './PlanComparison'

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
    name: 'NoSubscription',
    priceMonthlyCents: 1900,
    includedQuotaCents: 3000,
    concurrencyLimit: 20,
    selfServe: true,
  },
  {
    id: 'pro',
    name: 'Go',
    priceMonthlyCents: 14900,
    includedQuotaCents: 25000,
    concurrencyLimit: 100,
    selfServe: true,
  },
  {
    id: 'max',
    name: 'Team',
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
  vi.useRealTimers()
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
  it('compares documented limits, prices and bonuses without inventing billing cycles', () => {
    const host = render(
      <MemoryRouter>
        <PlanComparison plans={catalog} organizationPlan={plan} />
      </MemoryRouter>,
    )
    const row = (label: string) =>
      [...host.querySelectorAll('tr')].find((tr) => tr.querySelector('th')?.textContent === label)!
    expect(host.querySelector('thead')?.textContent).toContain('Starter')
    expect(host.querySelector('thead')?.textContent).toContain('Starter$5')
    expect(host.querySelector('thead')?.textContent).not.toContain('/ month')
    expect(row('Bonus amount').textContent).toContain('—Not specified$20$400')
    expect(row('Max Box size').textContent).toContain('1C · 2G · 10G')
    expect([...row('Max concurrency').querySelectorAll('td')].map((td) => td.textContent)).toEqual([
      '2',
      '4',
      '1,000',
      'By agreement',
    ])
    expect([...row('Retention reference point').querySelectorAll('td')].map((td) => td.textContent)).toEqual([
      'Payment becomes overdue',
      'Subscription ends',
      'Subscription ends',
      'By agreement',
    ])
    expect(row('Maximum time after that point').textContent).toContain('24 hours48 hours72 hours')
    expect(row('Hosted secrets').querySelectorAll('td')[2].textContent).toBe('Unlimited')
    expect(row('Box usage dashboard').querySelectorAll('td')[2].textContent).toBe('Included')
    expect(row('Key management')).toBeUndefined()
    expect(row('Enterprise SSO').textContent).toContain('Coming soon')
  })
  it.each([
    [1, '1 Second'],
    [3600, '1 Hour'],
    [5400, '1h 30m'],
    [86401, '1d 1s'],
  ])('shows the exact %i-second offer alongside the regular price', (durationSeconds, label) => {
    const host = render(
      <MemoryRouter>
        <PlanComparison
          plans={[
            { ...catalog[1], name: 'Starter', priceMonthlyCents: 500 },
            { ...catalog[2], name: 'Team', priceMonthlyCents: 10000 },
          ]}
          trialOffers={[
            { name: 'Team', eligible: true, durationSeconds },
            { name: 'Starter', eligible: true, durationSeconds: 259200 },
          ]}
        />
      </MemoryRouter>,
    )
    const [, starter, team] = host.querySelectorAll('thead th')
    expect(starter.textContent).toContain('Free Trial 3 Days')
    expect(team.textContent).toContain('Team$100')
    expect(team.textContent).toContain(`Free Trial ${label}`)
    const row = [...host.querySelectorAll('tr')].find((tr) => tr.cells[0].textContent === 'Trial eligibility')!
    expect(row.cells[2].textContent).toBe(`${String(label).toLowerCase()} · card verification required`)
  })
  it('keeps documented benefits attached to named tiers when the catalogue is reordered or incomplete', () => {
    const host = render(
      <MemoryRouter>
        <PlanComparison
          plans={[
            { ...catalog[2], name: 'Team' },
            { ...catalog[0], name: 'NoSubscription' },
            { ...catalog[1], name: 'Unrecognized', priceMonthlyCents: 1234 },
          ]}
        />
      </MemoryRouter>,
    )
    const headers = host.querySelectorAll('thead th')
    expect(headers[1].textContent).toContain('Team$100')
    expect(headers[2].textContent).toContain('Pay as you go')
    expect(headers[3].textContent).toContain('Unrecognized$12.34')
    const row = [...host.querySelectorAll('tr')].find((tr) => tr.querySelector('th')?.textContent === 'Hosted secrets')!
    expect([...row.querySelectorAll('td')].map((td) => td.textContent)).toEqual([
      'Unlimited',
      '2',
      '—Not specified',
      'By agreement',
    ])
  })
  it.each([undefined, { ...plan, status: 'canceled' as const }])(
    'shows PAYG as current without an active subscription',
    (subscription) => {
      const host = render(
        <MemoryRouter>
          <PlanComparison
            plans={catalog.map((entry, index) => ({ ...entry, priceMonthlyCents: [0, 500, 10000][index] }))}
            organizationPlan={subscription}
          />
          <RouteProbe />
        </MemoryRouter>,
      )
      const payg = host.querySelectorAll('thead th')[1]
      const button = payg.querySelector('button')
      expect(button?.textContent).toBe('Current plan')
      expect(button?.disabled).toBe(true)
      act(() => button?.click())
      expect(host.querySelector('output')?.textContent).toBe('/')
    },
  )
  it('exposes unspecified allowances and benefits to screen readers', () => {
    const host = render(
      <MemoryRouter>
        <PlanComparison plans={catalog} />
      </MemoryRouter>,
    )
    for (const label of ['Usage funding', 'Bonus amount', 'Trial eligibility', 'Volumes']) {
      const row = [...host.querySelectorAll('tr')].find((tr) => tr.querySelector('th')?.textContent === label)!
      expect(row.querySelector('[aria-hidden="true"]')?.textContent).toBe('—')
      expect(row.querySelector('.sr-only')?.textContent).toBe('Not specified')
    }
  })
  it('handles empty and extra catalogue entries without inventing benefits', () => {
    const host = render(
      <MemoryRouter>
        <PlanComparison plans={[]} />
        <PlanComparison plans={[...catalog, { ...catalog[2], id: 'extra', name: 'Extra' }]} />
      </MemoryRouter>,
    )
    expect(host.textContent).toContain('No plans are available right now.')
    const row = [...host.querySelectorAll('tr')].find((tr) => tr.querySelector('th')?.textContent === 'Max Box size')!
    expect(row.querySelectorAll('td')[3].textContent).toBe('—Not specified')
  })
  it('presents PAYG without a monthly price and prevents non-owner plan actions', () => {
    const host = render(
      <MemoryRouter>
        <PlanComparison
          plans={[{ ...catalog[0], name: 'NoSubscription', priceMonthlyCents: 0 }, ...catalog.slice(1)]}
          canManage={false}
        />
        <RouteProbe />
      </MemoryRouter>,
    )
    expect(host.querySelectorAll('thead th')[1].textContent).toContain('Pay as you go')
    expect(host.querySelectorAll('thead th')[1].textContent).not.toContain('$0')
    expect([...host.querySelectorAll('button')].every((button) => button.disabled)).toBe(true)
    expect(host.querySelectorAll('colgroup col[class]')).toHaveLength(1)
    expect(host.querySelector('a[href="mailto:support@boxlite.ai"]')).toBeNull()
  })
  it('offers contact instead of checkout when catalogue prices differ from the displayed design', () => {
    const host = render(
      <MemoryRouter>
        <PlanComparison plans={catalog} organizationPlan={plan} />
        <RouteProbe />
      </MemoryRouter>,
    )
    expect(host.querySelector('thead')?.textContent).toContain('Starter$5')
    expect(host.querySelectorAll('thead a[href="https://boxlite.ai/contact"]')).toHaveLength(3)
    expect([...host.querySelectorAll('thead button')].every((button) => button.disabled)).toBe(true)
    expect(host.querySelector('output')?.textContent).toBe('/')
  })
  it.each([500, 499])('checks the Starter catalogue price before checkout (%i cents)', (priceMonthlyCents) => {
    const host = render(
      <MemoryRouter>
        <PlanComparison plans={[{ ...catalog[1], priceMonthlyCents }]} />
        <RouteProbe />
      </MemoryRouter>,
    )
    const starter = host.querySelectorAll('thead th')[1]
    expect(starter.textContent).toContain('Starter$5')
    if (priceMonthlyCents === 500) {
      expect(starter.querySelector('a')).toBeNull()
      const button = starter.querySelector('button')!
      expect(button.disabled).toBe(false)
      act(() => button.click())
      expect(host.querySelector('output')?.textContent).toBe('/dashboard/billing/plan/pro')
    } else {
      expect(starter.querySelector('button')).toBeNull()
      expect(starter.querySelector('a')?.getAttribute('href')).toBe('https://boxlite.ai/contact')
      expect(host.querySelector('output')?.textContent).toBe('/')
    }
  })
  it('keeps plan price, consumed quota and wallet distinct in the compact summary', () => {
    const host = render(<CycleOverview wallet={wallet} organizationPlan={plan} catalogPlan={catalog[1]} />)
    expect(host.textContent).toContain('Pro$149/mo')
    expect(host.textContent).toContain('Wallet balance$10.00')
    expect(host.textContent).toContain('Quota consumed$62.50/ $250.00')
    expect(host.textContent).not.toContain('no subscription')
    expect(host.textContent).not.toContain('FREE TRIAL')
  })
  it('shows the remaining trial time in the active subscription summary', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-04T00:00:00.000Z'))
    const host = render(
      <CycleOverview
        wallet={wallet}
        organizationPlan={{
          ...plan,
          trial: {
            startedAt: new Date('2026-08-01T00:00:00.000Z'),
            endsAt: new Date('2026-08-07T00:00:00.000Z'),
            conversionAmountCents: 14900,
            currency: 'USD',
            conversionState: 'not_attempted',
          },
        }}
        catalogPlan={catalog[1]}
      />,
    )
    expect(host.textContent).toContain('Pro$149/mo')
    expect(host.textContent).toContain('FREE TRIAL')
    expect(host.textContent).toMatch(/3\s*days\s*left/)
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
        <PlanComparison
          plans={catalog.map((entry, index) => ({ ...entry, priceMonthlyCents: [0, 500, 10000][index] }))}
          organizationPlan={plan}
        />
        <RouteProbe />
      </MemoryRouter>,
    )
    const buttons = [...host.querySelectorAll('button')]
    expect(buttons.find((button) => button.textContent === 'Current plan')?.disabled).toBe(true)
    act(() => buttons.find((button) => button.textContent?.includes('Upgrade'))!.click())
    expect(host.querySelector('output')?.textContent).toBe('/dashboard/billing/plan/max')
    act(() => buttons.find((button) => button.textContent?.includes('Downgrade'))!.click())
    expect(host.querySelector('output')?.textContent).toBe('/dashboard/billing/plan/starter')
    expect(host.textContent).not.toContain('support@boxlite.ai')
    expect(host.querySelector('a[href="https://boxlite.ai/contact"]')?.textContent).toContain('Book a call')
    expect(host.querySelector('a[href="https://boxlite.ai/contact"]')?.getAttribute('target')).toBe('_blank')
  })
})
