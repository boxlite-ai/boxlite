// @vitest-environment jsdom
/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomaticTopUp } from '@/billing-api/types/OrganizationWallet'
import { DEFAULT_PAGE_SIZE } from '@/constants/Pagination'
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
  invoicesQuery: vi.fn(),
  walletTransactionsQuery: vi.fn(),
  wallet: {
    automaticTopUp: undefined as AutomaticTopUp | undefined,
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
  useOwnerInvoicesQuery: (page = 1, perPage?: number) => {
    mocks.invoicesQuery(page, perPage)
    return {
      data: {
        items: [
          {
            id: `invoice-${page}`,
            number: page === 1 ? 'BOX-2026-0002' : 'BOX-2026-0001',
            sequentialId: page === 1 ? 2 : 1,
            type: page === 1 ? 'one_off' : 'credit',
            chargedAt: page === 1 ? '2026-09-04T00:00:00.000Z' : '2026-08-30T00:00:00.000Z',
            totalAmountCents: page === 1 ? 1_212 : 5_000,
            totalPaidCents: page === 1 ? 1_212 : 5_000,
            quotaCoveredCents: 0,
            paymentStatus: 'succeeded',
            voided: false,
          },
        ],
        totalItems: DEFAULT_PAGE_SIZE * 2,
        totalPages: 2,
      },
      isLoading: false,
    }
  },
  useOwnerWalletTransactionsQuery: (page = 1, perPage?: number, enabled = true) => {
    if (!enabled) {
      return { data: undefined, isLoading: false }
    }

    mocks.walletTransactionsQuery(page, perPage, enabled)
    return {
      data: {
        items: [
          {
            id: `transaction-${page}`,
            direction: 'outbound',
            kind: 'invoiced',
            status: 'settled',
            source: 'usage',
            amountCents: page === 1 ? 420 : 810,
            name: null,
            subscriptionCreditKind: null,
            createdAt: page === 1 ? '2026-07-18T00:00:00.000Z' : '2026-07-15T00:00:00.000Z',
            settledAt: page === 1 ? '2026-07-18T00:00:00.000Z' : '2026-07-15T00:00:00.000Z',
          },
        ],
        totalItems: DEFAULT_PAGE_SIZE * 2,
        totalPages: 2,
      },
      isLoading: false,
    }
  },
  useOwnerPaymentMethodsQuery: () => ({ data: mocks.paymentMethods, isLoading: false, isError: false }),
  useOwnerPlanQuery: () => ({ data: { quotaRemainingCents: 0 } }),
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

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

function typeInto(element: HTMLInputElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
  descriptor?.set?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

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
    mocks.wallet.automaticTopUp = undefined
    mocks.wallet.ongoingBalanceCents = 0
    mocks.wallet.creditCardConnected = false
    mocks.topUpWallet.mockClear()
    mocks.invoicesQuery.mockClear()
    mocks.walletTransactionsQuery.mockClear()
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

    expect(document.body.textContent).toContain('Billing history')
    expect(document.body.textContent).toContain('Credit activity')
    expect(document.body.textContent).not.toContain('Usage Settlements')

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

  it('leads with the money history and folds the credit ledger away', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)

    await act(async () => {
      root = createRoot(host)
      root.render(<WalletSection />)
    })
    await flush()

    // The charge is on the page; the grant that shares its date is not, because
    // showing both at equal weight is what made a grant read as an amount billed.
    expect(document.body.textContent).toContain('BOX-2026-0002')
    expect(document.body.textContent).toContain('2026-09-04')
    expect(document.body.textContent).not.toContain('2026-07-18')

    const fold = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('Credit activity'),
    )
    expect(fold?.getAttribute('aria-expanded')).toBe('false')

    await act(async () => fold?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()

    expect(fold?.getAttribute('aria-expanded')).toBe('true')
    expect(document.body.textContent).toContain('2026-07-18')
  })

  it('loads older invoices when the billing history exceeds the first page', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)

    await act(async () => {
      root = createRoot(host)
      root.render(<WalletSection />)
    })
    await flush()

    expect(mocks.invoicesQuery).toHaveBeenCalledWith(1, DEFAULT_PAGE_SIZE)
    expect(document.body.textContent).toContain('2026-09-04')

    const nextPage = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Next →',
    )
    expect(nextPage).toBeDefined()

    await act(async () => nextPage?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()

    expect(mocks.invoicesQuery).toHaveBeenLastCalledWith(2, DEFAULT_PAGE_SIZE)
    expect(document.body.textContent).toContain('2026-08-30')
  })

  it('loads older transactions when credit activity exceeds the first page', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)

    await act(async () => {
      root = createRoot(host)
      root.render(<WalletSection />)
    })
    await flush()

    expect(mocks.walletTransactionsQuery).not.toHaveBeenCalled()

    const fold = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('Credit activity'),
    )
    await act(async () => fold?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()

    expect(mocks.walletTransactionsQuery).toHaveBeenCalledWith(1, DEFAULT_PAGE_SIZE, true)
    expect(document.body.textContent).toContain('2026-07-18')

    const creditActivity = document.querySelector('#credit-activity')
    const nextPage = [...(creditActivity?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (button) => button.textContent?.trim() === 'Next →',
    )
    expect(nextPage).toBeDefined()

    await act(async () => nextPage?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()

    expect(mocks.walletTransactionsQuery).toHaveBeenLastCalledWith(2, DEFAULT_PAGE_SIZE, true)
    expect(document.body.textContent).toContain('2026-07-15')
  })

  it('rounds a custom two-decimal dollar amount to integer cents', async () => {
    const checkoutWindow = { location: { href: '' }, close: vi.fn() }
    vi.spyOn(window, 'open').mockReturnValue(checkoutWindow as unknown as Window)
    const host = document.createElement('div')
    document.body.appendChild(host)

    await act(async () => {
      root = createRoot(host)
      root.render(<WalletSection />)
    })
    await flush()

    const customAmount = document.querySelector<HTMLInputElement>('#customTopUpAmount')
    expect(customAmount).not.toBeNull()

    await act(async () => {
      customAmount?.focus()
      if (customAmount) typeInto(customAmount, '10.13')
    })
    await flush()

    const topUpButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Top up →',
    )
    expect(topUpButton?.disabled).toBe(false)

    await act(async () => topUpButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()

    expect(mocks.topUpWallet).toHaveBeenCalledWith({ organizationId: 'org-without-card', amountCents: 1013 })
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

  it('fits the threshold warning below Auto-reload inside Wallet Balance', async () => {
    mocks.wallet.ongoingBalanceCents = 1_999
    mocks.wallet.automaticTopUp = { thresholdAmount: 20, targetAmount: 100 }
    const host = document.createElement('div')
    document.body.appendChild(host)

    await act(async () => {
      root = createRoot(host)
      root.render(<WalletSection />)
    })
    await flush()

    const autoReload = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('Auto-reload'),
    )
    const banner = document.querySelector<HTMLElement>('[data-balance-warning-level="below-threshold"]')

    expect(autoReload).toBeDefined()
    expect(banner).not.toBeNull()
    expect(banner?.parentElement).toBe(autoReload?.parentElement)
    expect(autoReload?.compareDocumentPosition(banner as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(banner?.classList.contains('w-full')).toBe(true)
    expect(banner?.classList.contains('min-w-0')).toBe(true)
  })
})
