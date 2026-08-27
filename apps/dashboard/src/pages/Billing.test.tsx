// @vitest-environment jsdom
/*
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import Billing from './Billing'

vi.mock('@/hooks/useConfig', () => ({
  useConfig: () => ({ billingApiUrl: 'https://billing.example.test' }),
}))

vi.mock('@/components/billing/BillingAlerts', () => ({ BillingAlerts: () => null }))
vi.mock('@/components/billing/BalanceLowBanner', () => ({
  BalanceLowBanner: ({ onGoToWallet }: { onGoToWallet: () => void }) => (
    <button data-testid="critical-balance-banner" onClick={onGoToWallet}>
      Critical balance warning
    </button>
  ),
}))
vi.mock('@/components/billing/PlanSection', () => ({
  PlanSection: () => <div data-testid="plan-section">Plan section</div>,
}))
vi.mock('@/components/billing/UsageSection', () => ({ UsageSection: () => <div>Usage section</div> }))
vi.mock('@/components/billing/WalletSection', () => ({
  WalletSection: () => <div data-testid="wallet-section">Wallet section</div>,
}))

function closestMaxWidthContainer(element: Element | null): Element | null {
  let current = element

  while (current) {
    if (current.classList.contains('max-w-[1440px]')) {
      return current
    }
    current = current.parentElement
  }

  return null
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
      root.render(<Billing />)
    })

    const heading = Array.from(document.querySelectorAll('h1')).find((element) => element.textContent === 'Billing')
    const tabs = document.querySelector('[data-slot="tabs-list"]')
    const activePanel = document.querySelector('[data-testid="plan-section"]')
    const headingContainer = closestMaxWidthContainer(heading ?? null)

    expect(headingContainer).not.toBeNull()
    expect(closestMaxWidthContainer(tabs)).toBe(headingContainer)
    expect(closestMaxWidthContainer(activePanel)).toBe(headingContainer)
  })

  it('keeps critical balance warnings between the title and tabs in the wide-page container', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)

    act(() => {
      root = createRoot(host)
      root.render(<Billing />)
    })

    const heading = Array.from(document.querySelectorAll('h1')).find((element) => element.textContent === 'Billing')
    const banner = document.querySelector('[data-testid="critical-balance-banner"]')
    const tabs = document.querySelector('[data-slot="tabs-list"]')
    const headingContainer = closestMaxWidthContainer(heading ?? null)

    expect(banner).not.toBeNull()
    expect(closestMaxWidthContainer(banner)).toBe(headingContainer)
    expect(heading?.compareDocumentPosition(banner as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(banner?.compareDocumentPosition(tabs as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(banner?.parentElement?.classList.contains('mt-4')).toBe(true)
    expect(banner?.parentElement?.classList.contains('w-full')).toBe(true)
    expect(tabs?.classList.contains('mt-5')).toBe(true)

    act(() => {
      ;(banner as HTMLElement).click()
    })
    expect(document.querySelector('[data-testid="wallet-section"]')).not.toBeNull()
  })
})
