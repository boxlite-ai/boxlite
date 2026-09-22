// @vitest-environment jsdom
/*
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import Billing from './Billing'

const config = vi.hoisted(() => ({ billingApiUrl: 'https://billing.example.test' }))

vi.mock('@/hooks/useConfig', () => ({
  useConfig: () => config,
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
vi.mock('@/components/billing/ReferralCodeSection', () => ({
  ReferralCodeSection: () => <div data-testid="referral-code-section">Invitation code</div>,
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
    config.billingApiUrl = 'https://billing.example.test'
  })

  it('shows the invitation code before the placeholder when billing is unavailable', () => {
    config.billingApiUrl = ''
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

    const invitation = document.querySelector('[data-testid="referral-code-section"]')
    const placeholder = document.querySelector('h1')
    expect(invitation).not.toBeNull()
    expect(placeholder?.textContent).toBe('Billing is on the way')
    expect(invitation?.compareDocumentPosition(placeholder as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(document.querySelector('[data-slot="tabs-list"]')).toBeNull()
    expect(document.querySelector('[data-testid="plan-section"]')).toBeNull()
    expect(document.querySelector('[data-testid="wallet-section"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Usage section')
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
    expect(closestMaxWidthContainer(document.querySelector('[data-testid="referral-code-section"]'))).toBe(
      headingContainer,
    )
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
