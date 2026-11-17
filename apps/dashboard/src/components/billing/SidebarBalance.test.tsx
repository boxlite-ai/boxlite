import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SidebarBalance } from './SidebarBalance'

const state = vi.hoisted(() => ({
  hasPlan: true,
  planStatus: 'active',
  role: 'owner',
  configured: true,
  failed: false,
  ready: true,
  topUp: false,
  grant: 0,
  credit: 0,
  balance: 1000,
  quota: 18750 as number | null,
}))
vi.mock('@/hooks/useConfig', () => ({ useConfig: () => ({ billingApiUrl: state.configured ? '/billing' : '' }) }))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: 'org-a' },
    authenticatedUserOrganizationMember: { role: state.role },
  }),
}))
vi.mock('@/hooks/queries/billingQueries', () => ({
  useOwnerWalletQuery: () => ({
    isSuccess: state.ready && !state.failed,
    isError: state.failed,
    data: {
      ongoingBalanceCents: state.balance,
      creditGrantedCents: state.grant,
      creditRemainingCents: state.credit,
      automaticTopUp: state.topUp ? { thresholdAmount: 20, targetAmount: 50 } : undefined,
    },
  }),
  useOwnerPlanQuery: () => ({
    isSuccess: state.ready,
    isError: false,
    data: state.hasPlan
      ? { planName: 'Pro', status: state.planStatus, quotaRemainingCents: state.quota, includedQuotaCents: 25000 }
      : null,
  }),
}))
function render(expanded = true) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <SidebarBalance expanded={expanded} />
    </MemoryRouter>,
  )
}
beforeEach(() =>
  Object.assign(state, {
    grant: 0,
    topUp: false,
    credit: 0,
    hasPlan: true,
    planStatus: 'active',
    role: 'owner',
    configured: true,
    failed: false,
    ready: true,
    balance: 1000,
    quota: 18750,
  }),
)

describe('SidebarBalance', () => {
  it.each([
    { planStatus: 'active', quota: 0 },
    { planStatus: 'canceled', quota: 18750 },
  ])('shows an empty wallet when the $planStatus plan has no usable allowance', (plan) => {
    Object.assign(state, plan, { balance: 0 })
    const html = render()
    expect(html).toContain('Wallet')
    expect(html).toContain('$0.00')
    expect(html).toContain('No balance remaining')
    expect(html).not.toContain('Pro')
    expect(html).not.toContain('role="meter"')
  })
  it('does not describe a canceled plan as spent when the wallet is funded', () => {
    state.planStatus = 'canceled'
    const html = render()
    expect(html).toContain('Wallet')
    expect(html).toContain('$10.00')
    expect(html).not.toContain('Plan used up')
  })
  it('uses the configured automatic reload threshold for wallet warnings', () => {
    Object.assign(state, { hasPlan: false, topUp: true })
    expect(render()).toContain('Below auto-reload threshold')
  })
  it.each([0, 1000])('keeps compact billing reachable with wallet balance %s', (balance) => {
    Object.assign(state, { hasPlan: false, balance })
    const html = render(false)
    expect(html).toContain('href="/dashboard/billing"')
    expect(html).toContain('aria-label="View billing and balance"')
    expect(html.includes('bg-warning')).toBe(balance === 0)
    expect(html).not.toContain('role="meter"')
  })
  it('prioritizes funded plan allowance without stacking the wallet balance', () => {
    const html = render()
    expect(html).toContain('$187.50')
    expect(html).not.toContain('$10.00')
    expect(html).toContain('25% used')
    expect(html).toContain('href="/dashboard/billing"')
  })
  it('uses the wallet balance even when optional legacy credit fields are present', () => {
    Object.assign(state, { hasPlan: false, balance: 10000, grant: 10000, credit: 10000 })
    const html = render()
    expect(html).toContain('Wallet')
    expect(html).not.toContain('Free credits')
    expect(html).toContain('$100.00')
    expect(html).not.toContain('role="meter"')
    expect(html).not.toContain('No balance remaining')
    expect(html).not.toContain('$0.00')
  })
  it('does not invent welcome credit when none has been granted', () => {
    Object.assign(state, { hasPlan: false, balance: 0 })
    expect(render()).not.toContain('Free credits')
    expect(render()).toContain('No balance remaining')
  })
  it('shows wallet-only customers a balance without a fabricated progress denominator', () => {
    state.hasPlan = false
    const html = render()
    expect(html).toContain('Wallet')
    expect(html).toContain('$10.00')
    expect(html).not.toContain('role="meter"')
  })
  it('shows subscription-only customers no empty wallet row', () => {
    state.balance = 0
    expect(render()).toContain('$187.50')
    expect(render()).not.toContain('$0.00')
  })
  it('switches to wallet after the plan is exhausted with a short explanation', () => {
    state.quota = 0
    expect(render()).toContain('$10.00')
    expect(render()).toContain('Plan used up · using wallet')
    expect(render()).not.toContain('role="meter"')
  })
  it('surfaces an overdrawn wallet even if plan allowance remains', () => {
    state.balance = -500
    expect(render()).toContain('Wallet overdrawn')
    expect(render()).not.toContain('$187.50')
  })
  it('hides billing data from non-owners even when query data is cached', () => {
    state.role = 'member'
    expect(render()).toBe('')
  })
  it('hides the summary when billing is not configured', () => {
    state.configured = false
    expect(render()).toBe('')
  })
  it('shows loading and failure without presenting stale monetary data', () => {
    state.ready = false
    expect(render()).toContain('Loading billing')
    expect(render()).not.toContain('$10.00')
    state.failed = true
    expect(render()).toContain('Balance unavailable')
    expect(render()).not.toContain('$10.00')
  })
  it('warns only when both wallet and allowance are empty', () => {
    state.balance = 0
    expect(render()).not.toContain('No balance remaining')
    state.quota = 0
    expect(render()).toContain('No balance remaining')
  })
  it('does not render unlimited allowance as an empty progress bar', () => {
    state.quota = null
    expect(render()).toContain('Unlimited')
    expect(render()).not.toContain('role="meter"')
    expect(render(false)).toContain('View billing and balance')
  })
})
