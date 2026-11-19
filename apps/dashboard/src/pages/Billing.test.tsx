// @vitest-environment jsdom
/*
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import Billing from './Billing'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'

vi.mock('@/components/billing/PlanSetupReturn', () => ({ PlanSetupReturn: () => null }))
vi.mock('@/hooks/useConfig', () => ({
  useConfig: () => ({ billingApiUrl: 'https://billing.example.test' }),
}))

vi.mock('@/components/billing/BillingAlerts', () => ({
  BillingAlerts: () => null,
}))
vi.mock('@/components/billing/BalanceLowBanner', () => ({
  BalanceLowBanner: ({ onGoToWallet }: { onGoToWallet: () => void }) => (
    <button data-testid="critical-balance-banner" onClick={onGoToWallet}>
      Critical balance warning
    </button>
  ),
}))
vi.mock('@/components/billing/PlanSection', () => ({
  PlanSection: ({ onViewPlans }: { onViewPlans: () => void }) => (
    <div data-testid="plan-section">
      <button onClick={onViewPlans}>View plans</button>
    </div>
  ),
}))
vi.mock('@/components/billing/PlansSection', () => ({
  PlansSection: () => <div data-testid="plans-comparison">Plans comparison</div>,
}))
vi.mock('@/components/billing/UsageSection', () => ({ UsageSection: () => <div>Usage section</div> }))
vi.mock('@/components/billing/WalletSection', () => ({
  WalletSection: ({
    linkCouponCode,
    onCouponClaimAccepted,
  }: {
    linkCouponCode?: string
    onCouponClaimAccepted?: () => void
  }) => (
    <div data-testid="wallet-section">
      <span data-testid="wallet-link-coupon-code">{linkCouponCode ?? ''}</span>
      <button onClick={onCouponClaimAccepted}>Claim accepted</button>
    </div>
  ),
}))

function closestPageContainer(element: Element | null): Element | null {
  let current = element

  while (current) {
    if (current.classList.contains('page-container')) {
      return current
    }
    current = current.parentElement
  }

  return null
}

function LocationProbe() {
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <output>{location.search}</output>
      <button onClick={() => navigate(-1)}>Back in history</button>
    </>
  )
}

describe('Billing layout', () => {
  let root: Root | null = null

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
  })

  it('keeps the title, tabs, and active panel in one wide-page container', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)

    act(() => {
      root = createRoot(host)
      root.render(
        <MemoryRouter>
          <Billing />
        </MemoryRouter>,
      )
    })

    const heading = Array.from(document.querySelectorAll('h1')).find((element) => element.textContent === 'Billing')
    const tabs = document.querySelector('[data-slot="tabs-list"]')
    const activePanel = document.querySelector('[data-testid="plan-section"]')
    const headingContainer = closestPageContainer(heading ?? null)

    expect(headingContainer).not.toBeNull()
    expect(closestPageContainer(tabs)).toBe(headingContainer)
    expect(closestPageContainer(activePanel)).toBe(headingContainer)
  })

  it('keeps critical balance warnings between the title and tabs in the wide-page container', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)

    act(() => {
      root = createRoot(host)
      root.render(
        <MemoryRouter>
          <Billing />
        </MemoryRouter>,
      )
    })

    const heading = Array.from(document.querySelectorAll('h1')).find((element) => element.textContent === 'Billing')
    const banner = document.querySelector('[data-testid="critical-balance-banner"]')
    const tabs = document.querySelector('[data-slot="tabs-list"]')
    const headingContainer = closestPageContainer(heading ?? null)

    expect(banner).not.toBeNull()
    expect(closestPageContainer(banner)).toBe(headingContainer)
    expect(heading?.compareDocumentPosition(banner as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(banner?.compareDocumentPosition(tabs as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(banner?.parentElement?.classList.contains('mt-4')).toBe(true)
    expect(banner?.parentElement?.classList.contains('w-full')).toBe(true)
    expect(tabs?.parentElement?.classList.contains('mt-5')).toBe(true)

    act(() => {
      ;(banner as HTMLElement).click()
    })
    expect(document.querySelector('[data-testid="wallet-section"]')).not.toBeNull()
  })
  it('opens Plans from Overview, preserves preview parameters and supports history', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    act(() => {
      root = createRoot(host)
      root.render(
        <MemoryRouter initialEntries={['/dashboard/billing?preview=subscription-cards']}>
          <Billing />
          <LocationProbe />
        </MemoryRouter>,
      )
    })
    act(() => [...host.querySelectorAll('button')].find((button) => button.textContent === 'View plans')!.click())
    expect(host.querySelector('[data-testid="plans-comparison"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="plan-section"]')).toBeNull()
    expect(host.querySelector('output')?.textContent).toBe('?preview=subscription-cards&tab=plans')
    act(() => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Back in history')!.click())
    expect(host.querySelector('[data-testid="plan-section"]')).not.toBeNull()
  })

  it('loads a direct Plans URL without showing the Overview panel', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    act(() => {
      root = createRoot(host)
      root.render(
        <MemoryRouter initialEntries={['/dashboard/billing?tab=plans']}>
          <Billing />
        </MemoryRouter>,
      )
    })
    expect(host.querySelector('[data-testid="plans-comparison"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="plan-section"]')).toBeNull()
  })

  it('passes a coupon link code to Wallet and drops it from the URL once accepted', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    act(() => {
      root = createRoot(host)
      root.render(
        <MemoryRouter initialEntries={['/dashboard/billing?tab=wallet&code=ACME50']}>
          <Billing />
          <LocationProbe />
        </MemoryRouter>,
      )
    })
    expect(host.querySelector('[data-testid="wallet-link-coupon-code"]')?.textContent).toBe('ACME50')
    act(() => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Claim accepted')!.click())
    expect(host.querySelector('output')?.textContent).toBe('?tab=wallet')
    expect(host.querySelector('[data-testid="wallet-link-coupon-code"]')?.textContent).toBe('')
  })
})
