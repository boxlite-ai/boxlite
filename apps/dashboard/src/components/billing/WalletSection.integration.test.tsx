// @vitest-environment jsdom
/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WalletSection } from './WalletSection'

const mocks = vi.hoisted(() => ({
  fetchCheckoutUrl: vi.fn(),
  paymentMethods: [] as Array<{
    id: string
    isDefault: boolean
    paymentProviderType: 'stripe'
    providerMethodId: string
    details: Record<string, unknown>
  }>,
  redeemCoupon: vi.fn(),
  setAutomaticTopUp: vi.fn(),
  topUpWallet: vi.fn(),
  wallet: {
    balanceCents: 0,
    ongoingBalanceCents: 0,
    name: 'Wallet',
    creditCardConnected: false,
  },
}))

vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({ selectedOrganization: { id: 'org-without-card' } }),
}))

vi.mock('react-oidc-context', () => ({
  useAuth: () => ({ user: { profile: { email_verified: true } } }),
}))

vi.mock('@/hooks/queries/billingQueries', () => ({
  useFetchOwnerCheckoutUrlQuery: () => mocks.fetchCheckoutUrl,
  useIsOwnerCheckoutUrlFetching: () => false,
  useOwnerBillingPortalUrlQuery: () => ({ data: undefined, isLoading: false }),
  useOwnerInvoicesQuery: () => ({ data: { items: [], totalItems: 0, totalPages: 0 }, isLoading: false }),
  useOwnerPaymentMethodsQuery: () => ({ data: mocks.paymentMethods, isLoading: false, isError: false }),
  useOwnerWalletQuery: () => ({ data: mocks.wallet, isLoading: false }),
}))

vi.mock('@/hooks/mutations/useRedeemCouponMutation', () => ({
  useRedeemCouponMutation: () => ({ mutateAsync: mocks.redeemCoupon, isPending: false }),
}))

vi.mock('@/hooks/mutations/useSetAutomaticTopUpMutation', () => ({
  useSetAutomaticTopUpMutation: () => ({ mutateAsync: mocks.setAutomaticTopUp, isPending: false }),
}))

vi.mock('@/hooks/mutations/useTopUpWalletMutation', () => ({
  useTopUpWalletMutation: () => ({ mutateAsync: mocks.topUpWallet, isPending: false }),
}))

vi.mock('@/components/Invoices', () => ({ InvoicesTable: () => null }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('WalletSection top-up checkout', () => {
  let root: Root | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    mocks.paymentMethods = []
    mocks.wallet.creditCardConnected = false
    mocks.topUpWallet.mockResolvedValue({ url: 'https://checkout.stripe.com/pay/cs_top_up' })
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('opens the returned payment page for an organization without a saved card', async () => {
    const checkoutWindow = { location: { href: '' }, close: vi.fn() }
    const open = vi.spyOn(window, 'open').mockReturnValue(checkoutWindow as unknown as Window)
    const host = document.createElement('div')
    document.body.appendChild(host)

    await act(async () => {
      root = createRoot(host)
      root.render(<WalletSection />)
    })
    await flush()

    const topUpButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Top up →',
    )
    const connectButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Connect',
    )
    expect(connectButton).toBeDefined()
    expect(topUpButton).toBeDefined()
    expect(topUpButton?.disabled).toBe(false)

    await act(async () => topUpButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()

    expect(open).toHaveBeenCalledWith('', '_blank')
    expect(mocks.topUpWallet).toHaveBeenCalledWith({ organizationId: 'org-without-card', amountCents: 10_000 })
    expect(checkoutWindow.location.href).toBe('https://checkout.stripe.com/pay/cs_top_up')
  })

  it('renders every stored method and marks only the API default as chargeable', async () => {
    mocks.wallet.creditCardConnected = true
    mocks.paymentMethods = [
      {
        id: 'card-secondary',
        isDefault: false,
        paymentProviderType: 'stripe',
        providerMethodId: 'pm_secondary',
        details: { brand: 'visa', last4: '4242', expMonth: 8, expYear: 2027 },
      },
      {
        id: 'card-default',
        isDefault: true,
        paymentProviderType: 'stripe',
        providerMethodId: 'pm_default',
        details: { brand: 'mastercard', last4: '4444', expMonth: 12, expYear: 2029 },
      },
      {
        id: 'card-legacy',
        isDefault: false,
        paymentProviderType: 'stripe',
        providerMethodId: 'pm_legacy',
        details: {},
      },
    ]
    const host = document.createElement('div')
    document.body.appendChild(host)

    await act(async () => {
      root = createRoot(host)
      root.render(<WalletSection />)
    })
    await flush()

    const list = document.querySelector('ul[aria-label="Saved payment methods"]')
    const rows = [...(list?.querySelectorAll('li') ?? [])]
    expect(rows).toHaveLength(3)
    expect(list?.textContent).toContain('VISA')
    expect(list?.textContent).toContain('•••• 4242')
    expect(list?.textContent).toContain('exp 08/27')
    expect(list?.textContent).toContain('MASTERCARD')
    expect(list?.textContent).toContain('•••• 4444')
    expect(list?.textContent).toContain('exp 12/29')
    expect(list?.textContent).toContain('CARD')
    expect(list?.textContent).toContain('Saved card')
    expect(rows[0].textContent).not.toContain('Used for subscription renewal and top-up charges')
    expect(rows[1].textContent).toContain('Used for subscription renewal and top-up charges')
    const updateButtons = [...document.querySelectorAll('button')].filter(
      (button) => button.textContent?.trim() === 'Update card',
    )
    expect(updateButtons).toHaveLength(1)
    // Keeping the action inside the first full-width row lets that row's
    // divider reach the panel's right edge instead of stopping at an action rail.
    expect(rows[0].contains(updateButtons[0])).toBe(true)
    expect(document.body.textContent).not.toContain('pm_default')
  })
})
