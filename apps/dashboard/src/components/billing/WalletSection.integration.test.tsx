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
  redeemCoupon: vi.fn(),
  setAutomaticTopUp: vi.fn(),
  topUpWallet: vi.fn(),
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
  useOwnerWalletQuery: () => ({
    data: {
      balanceCents: 0,
      ongoingBalanceCents: 0,
      name: 'Wallet',
      creditCardConnected: false,
    },
    isLoading: false,
  }),
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
    expect(topUpButton).toBeDefined()
    expect(topUpButton?.disabled).toBe(false)

    await act(async () => topUpButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()

    expect(open).toHaveBeenCalledWith('', '_blank')
    expect(mocks.topUpWallet).toHaveBeenCalledWith({ organizationId: 'org-without-card', amountCents: 10_000 })
    expect(checkoutWindow.location.href).toBe('https://checkout.stripe.com/pay/cs_top_up')
  })
})
