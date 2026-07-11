// @vitest-environment jsdom
/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Billing from './Billing'

const state = vi.hoisted(() => ({
  mode: 'ready' as 'ready' | 'loading' | 'error',
  role: 'owner',
}))

const overview = {
  wallet: {
    freeBalanceCents: '8400',
    paidBalanceCents: '2500',
    totalBalanceCents: '10900',
    billingStatus: 'trial',
    freeExpiresAt: '2026-08-09T10:00:00.000Z',
  },
  spentThisMonthCents: '37',
  usage: {
    costPreciseCents: '2.778',
    costCents: '3',
    cpuSeconds: '1200',
    memGibSeconds: '2400',
    diskGibSeconds: '6000',
    gpuSeconds: '0',
    periodCount: 2,
  },
  usageBuckets: Array.from({ length: 12 }, (_, index) => ({
    from: new Date(Date.UTC(2026, 6, 1, index)).toISOString(),
    to: new Date(Date.UTC(2026, 6, 1, index + 1)).toISOString(),
    costPreciseCents: String(index / 10),
    costCents: String(Math.round(index / 10)),
    cpuSeconds: String(index * 60),
    memGibSeconds: String(index * 120),
    diskGibSeconds: String(index * 600),
    gpuSeconds: '0',
    periodCount: index > 0 ? 1 : 0,
  })),
  pricing: {
    version: 1,
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    cpuRateCentsPerHour: '5.04',
    memRateCentsPerHour: '1.62',
    diskRateCentsPerHour: '0.0108',
    gpuRateCentsPerHour: '0',
  },
}

vi.mock('react-router-dom', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/limits">{children}</a>,
}))

vi.mock('@/components/PageLayout', () => ({
  PageLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  PageContent: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  PageTitle: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
}))

vi.mock('@/components/billing/BillingPaymentPanel', () => ({
  BillingPaymentPanel: () => <div>Auto-reload One-time top-up Receipts</div>,
}))

vi.mock('@/components/billing/BillingPaymentMethodSection', () => ({
  BillingPaymentMethodSection: ({ onAddFunds }: { onAddFunds?: () => void }) => (
    <div>
      Payment method Set up payment method
      <button type="button" onClick={onAddFunds}>
        Add funds
      </button>
    </div>
  ),
}))

vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: {
      id: 'org-1',
      name: 'Acme',
      maxCpuPerBox: 4,
      maxMemoryPerBox: 8,
      maxDiskPerBox: 10,
    },
    authenticatedUserOrganizationMember: { role: state.role },
  }),
}))

vi.mock('@/hooks/queries/useBillingOverviewQuery', () => ({
  useBillingOverviewQuery: () =>
    state.mode === 'ready'
      ? { data: overview, isLoading: false, isError: false, refetch: vi.fn(), isFetching: false }
      : {
          data: undefined,
          isLoading: state.mode === 'loading',
          isError: state.mode === 'error',
          refetch: vi.fn(),
          isFetching: false,
        },
}))

async function flushReactWork() {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('Billing page', () => {
  let root: Root | null = null

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
  })

  beforeEach(() => {
    state.mode = 'ready'
    state.role = 'owner'
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  async function renderBilling() {
    const host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRoot(host)
      root.render(<Billing />)
    })
    await flushReactWork()
  }

  it('restores the PM usage layout around real wallet and usage data', async () => {
    await renderBilling()

    expect(document.querySelector('[data-testid="billing-balance-overview"]')).toBeTruthy()
    expect(document.querySelector('[aria-label="109.00"]')).toBeTruthy()
    expect(document.body.textContent).toContain('Free balance $84.00')
    expect(document.body.textContent).toContain('Paid balance $25.00')
    expect(document.body.textContent).toContain('Usage over time')
    expect(document.querySelectorAll('[data-usage-card]')).toHaveLength(4)
    expect(document.querySelector('[data-testid="billing-limits-panel"]')).toBeTruthy()
    expect(document.body.textContent).not.toContain('Pricing v1')
    expect(document.body.textContent).not.toContain('Billing is on the way')
  })

  it('keeps payment setup with the Usage balance and limits Billing to payment operations', async () => {
    await renderBilling()

    const usageTab = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Usage')
    const billingTab = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Billing',
    )
    expect(usageTab?.getAttribute('data-state')).toBe('active')
    expect(billingTab).toBeTruthy()
    expect(document.body.textContent).toContain('Payment method')
    expect(document.body.textContent).toContain('Set up payment method')
    if (!billingTab) throw new Error('Billing tab is missing')
    const addFunds = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Add funds',
    )
    if (!addFunds) throw new Error('Add funds button is missing')

    await act(async () => {
      addFunds.click()
    })

    expect(billingTab.getAttribute('data-state')).toBe('active')
    expect(document.body.textContent).toContain('Auto-reload')
    expect(document.body.textContent).toContain('One-time top-up')
    expect(document.body.textContent).toContain('Receipts')
    expect(document.body.textContent).not.toContain('Payment method')
    expect(document.body.textContent).not.toContain('Set up payment method')
    expect(document.body.textContent).not.toContain('Rated usage')
  })

  it('does not present unavailable billing data as a zero balance', async () => {
    state.mode = 'error'
    await renderBilling()

    expect(document.body.textContent).toContain('Billing data is unavailable')
    expect(document.body.textContent).not.toContain('$0.00')
  })

  it('keeps organization billing private to owners', async () => {
    state.role = 'member'
    await renderBilling()

    expect(document.body.textContent).toContain('Only organization owners can view billing')
    expect(document.body.textContent).not.toContain('$109.00')
  })
})
