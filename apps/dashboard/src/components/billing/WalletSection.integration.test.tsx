// @vitest-environment jsdom
/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import visaLogo from '@/assets/payment-brands/visa.svg'
import mastercardLogo from '@/assets/payment-brands/mastercard.svg'
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomaticTopUp } from '@/billing-api/types/OrganizationWallet'
import { DEFAULT_PAGE_SIZE } from '@/constants/Pagination'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { toast } from 'sonner'
import { CouponClaimUnconfirmedError } from '@/api/coupon-claim'
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
  claimCoupon: vi.fn(),
  accountId: 'owner-1',
  organizationId: 'org-without-card',
  membersStatus: 'ready',
  refreshMembers: vi.fn(),
  emailVerified: true,
  memberRole: 'owner',
  // Two organizations make the target ambiguous, so a coupon link waits for a click.
  organizations: [{ id: 'org-without-card' }, { id: 'org-other' }] as Array<{ id: string }>,
  setAutomaticTopUp: vi.fn(),
  setDefaultPaymentMethod: vi.fn(),
  removePaymentMethod: vi.fn(),
  topUpWallet: vi.fn(),
  invoicesQuery: vi.fn(),
  walletTransactionsQuery: vi.fn(),
  // A history that has not reported its size yet, as on first load.
  totalsUnknown: false,
  // The query itself has not answered at all.
  historiesPending: false,
  historiesError: false,
  historyRefreshError: false,
  historyRefreshing: false,
  refetchHistory: vi.fn(),
  failLaterPage: false,
  // The wallet query has not answered yet.
  walletPending: false,
  walletPlaceholder: false,
  // A top-up request is in flight.
  topUpPending: false,
  wallet: {
    automaticTopUp: undefined as AutomaticTopUp | undefined,
    balanceCents: 0,
    ongoingBalanceCents: 0,
    name: 'Wallet',
    creditCardConnected: false,
    usageChargeMultiplier: undefined as string | undefined,
  },
}))

vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: mocks.organizationId, name: 'Acme Labs' },
    organizationMembersStatus: mocks.membersStatus,
    refreshOrganizationMembers: mocks.refreshMembers,
    authenticatedUserOrganizationMember: { role: mocks.memberRole },
  }),
}))

vi.mock('@/hooks/useOrganizations', () => ({
  useOrganizations: () => ({ organizations: mocks.organizations }),
}))

vi.mock('react-oidc-context', () => ({
  useAuth: () => ({ user: { profile: { sub: mocks.accountId, email_verified: mocks.emailVerified } } }),
}))

vi.mock('@/hooks/useApi', () => ({ useApi: () => ({ claimCoupon: mocks.claimCoupon }) }))

vi.mock('@/hooks/queries/billingQueries', () => ({
  useFetchOwnerCheckoutUrlQuery: () => mocks.fetchCheckoutUrl,
  useIsOwnerCheckoutUrlFetching: () => false,
  useOwnerBillingPortalUrlQuery: () => ({ data: undefined, isLoading: false }),
  useOwnerInvoicesQuery: (page = 1, perPage?: number) => {
    mocks.invoicesQuery(page, perPage)
    if (mocks.historiesError || (mocks.failLaterPage && page > 1))
      return { data: undefined, isLoading: false, isError: true, refetch: mocks.refetchHistory }
    if (mocks.historiesPending) return { data: undefined, isLoading: true }
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
        totalItems: mocks.totalsUnknown ? undefined : DEFAULT_PAGE_SIZE * 2,
        totalPages: 2,
      },
      isLoading: false,
      isError: mocks.historyRefreshError,
      isFetching: mocks.historyRefreshing,
      refetch: mocks.refetchHistory,
    }
  },
  useOwnerWalletTransactionsQuery: (page = 1, perPage?: number) => {
    mocks.walletTransactionsQuery(page, perPage)
    if (mocks.historiesError || (mocks.failLaterPage && page > 1))
      return { data: undefined, isLoading: false, isError: true, refetch: mocks.refetchHistory }
    if (mocks.historiesPending) return { data: undefined, isLoading: true }
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
        totalItems: mocks.totalsUnknown ? undefined : DEFAULT_PAGE_SIZE * 2,
        totalPages: 2,
      },
      isLoading: false,
      isError: mocks.historyRefreshError,
      isFetching: mocks.historyRefreshing,
      refetch: mocks.refetchHistory,
    }
  },
  useOwnerPaymentMethodsQuery: () => ({ data: mocks.paymentMethods, isLoading: false, isError: false }),
  useOwnerPlanQuery: () => ({ data: { quotaRemainingCents: 0 } }),
  useOwnerWalletQuery: () => ({
    data: mocks.walletPending ? undefined : mocks.wallet,
    isLoading: mocks.walletPending,
    isPlaceholderData: mocks.walletPlaceholder,
  }),
}))

vi.mock('@/hooks/mutations/useRedeemCouponMutation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/mutations/useRedeemCouponMutation')>()),
  useRedeemCouponMutation: () => ({ mutateAsync: mocks.redeemCoupon, isPending: false }),
}))

vi.mock('@/hooks/mutations/useSetAutomaticTopUpMutation', () => ({
  useSetAutomaticTopUpMutation: () => ({ mutateAsync: mocks.setAutomaticTopUp, isPending: false }),
}))

vi.mock('@/hooks/mutations/useSetDefaultPaymentMethodMutation', () => ({
  useSetDefaultPaymentMethodMutation: () => ({ mutateAsync: mocks.setDefaultPaymentMethod, isPending: false }),
}))

vi.mock('@/hooks/mutations/useRemovePaymentMethodMutation', () => ({
  useRemovePaymentMethodMutation: () => ({ mutateAsync: mocks.removePaymentMethod, isPending: false }),
}))

vi.mock('@/hooks/mutations/useTopUpWalletMutation', () => ({
  useTopUpWalletMutation: () => ({ mutateAsync: mocks.topUpWallet, isPending: mocks.topUpPending }),
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))

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
    mocks.wallet.usageChargeMultiplier = undefined
    mocks.topUpWallet.mockClear()
    mocks.setDefaultPaymentMethod.mockReset().mockResolvedValue(undefined)
    mocks.removePaymentMethod.mockReset().mockResolvedValue(undefined)
    mocks.fetchCheckoutUrl.mockReset()
    mocks.invoicesQuery.mockClear()
    mocks.walletTransactionsQuery.mockClear()
    mocks.topUpWallet.mockResolvedValue({ url: 'https://checkout.stripe.com/pay/cs_top_up' })
    mocks.fetchCheckoutUrl.mockResolvedValue('https://checkout.stripe.com/c/pay/cs_connect')
    mocks.totalsUnknown = false
    mocks.historyRefreshError = false
    mocks.historyRefreshing = false
    mocks.historiesError = false
    mocks.failLaterPage = false
    mocks.refetchHistory.mockClear()
    mocks.historiesPending = false
    mocks.walletPending = false
    mocks.walletPlaceholder = false
    mocks.topUpPending = false
    mocks.emailVerified = true
    mocks.accountId = 'owner-1'
    mocks.organizationId = 'org-without-card'
    mocks.membersStatus = 'ready'
    sessionStorage.clear()
    mocks.memberRole = 'owner'
    mocks.organizations = [{ id: 'org-without-card' }, { id: 'org-other' }]
    mocks.redeemCoupon.mockReset()
    mocks.claimCoupon.mockReset()
    vi.mocked(toast.info).mockClear()
    vi.mocked(toast.success).mockClear()
    vi.mocked(toast.error).mockClear()
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('connects a card through the shared checkout action', async () => {
    const checkoutWindow = { location: { href: '' }, close: vi.fn() }
    const open = vi.spyOn(window, 'open').mockReturnValue(checkoutWindow as unknown as Window)
    const host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRoot(host)
      root.render(<WalletSection />)
    })
    const connect = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Add payment method',
    )
    expect(connect).toBeDefined()
    await act(async () => connect!.click())
    expect(open).toHaveBeenCalledWith('', '_blank')
    expect(mocks.fetchCheckoutUrl).toHaveBeenCalledTimes(1)
    expect(checkoutWindow.location.href).toBe('https://checkout.stripe.com/c/pay/cs_connect')
    expect(mocks.topUpWallet).not.toHaveBeenCalled()
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
      (button) => button.textContent?.trim() === 'Add payment method',
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

  it('stands up before either history has answered', async () => {
    mocks.historiesPending = true
    const host = document.createElement('div')
    document.body.appendChild(host)

    await act(async () => {
      root = createRoot(host)
      root.render(<WalletSection />)
    })
    await flush()

    // Both tabs exist with nothing in them yet, rather than the section
    // refusing to render until the server has counted.
    const tabs = Array.from(document.querySelectorAll('button')).filter((button) =>
      /Billing history|Credit activity/.test(button.textContent ?? ''),
    )
    expect(tabs).toHaveLength(2)
  })

  it('labels a tab without a number until its history reports one', async () => {
    mocks.totalsUnknown = true
    const host = document.createElement('div')
    document.body.appendChild(host)

    await act(async () => {
      root = createRoot(host)
      root.render(<WalletSection />)
    })
    await flush()

    // A tab is sized by its own history. Before that history has answered,
    // the label carries no number rather than a placeholder zero, which would
    // read as "this account has none".
    const tab = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.startsWith('Billing history'),
    )
    expect(tab?.textContent?.trim()).toBe('Billing history')
  })

  it('keeps the two money histories on separate tabs, each sized in its label', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)

    await act(async () => {
      root = createRoot(host)
      root.render(<WalletSection />)
    })
    await flush()

    // Billing history leads: it is the money actually taken. The grant sharing
    // a date with a charge is not on screen, because showing both at equal
    // weight is what made a grant read as an amount billed.
    expect(document.body.textContent).toContain('BOX-2026-0002')
    expect(document.body.textContent).toContain('2026-09-04')
    expect(document.body.textContent).not.toContain('2026-07-18')

    // Both tabs carry their size, so the ledger is sized up without opening it.
    const tabs = [...document.querySelectorAll<HTMLElement>('[role="tab"]')]
    const creditTab = tabs.find((tab) => tab.textContent?.includes('Credit activity'))
    expect(tabs.find((tab) => tab.textContent?.includes('Billing history'))?.textContent).toContain('50')
    expect(creditTab?.textContent).toContain('50')

    await act(async () => {
      creditTab?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      creditTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    // Switching shows the ledger and takes the invoices away: one table at a
    // time is what keeps a grant from ever sitting beside a charge.
    expect(document.body.textContent).toContain('2026-07-18')
    expect(document.body.textContent).not.toContain('BOX-2026-0002')
  })

  it.each([
    ['Billing history', 'BOX-2026-0002', 'refreshing'],
    ['Credit activity', '2026-07-18', 'refreshing'],
    ['Billing history', 'BOX-2026-0002', 'error'],
    ['Credit activity', '2026-07-18', 'error'],
  ])('retains loaded %s during %s (%s)', async (tabName, record, phase) => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRoot(host)
      root.render(<WalletSection />)
    })
    if (tabName === 'Credit activity') {
      const tab = [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find((el) =>
        el.textContent?.includes(tabName),
      )!
      await act(async () => {
        tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
        tab.click()
      })
    }
    expect(host.textContent).toContain(record)
    mocks.historyRefreshing = phase === 'refreshing'
    mocks.historyRefreshError = phase === 'error'
    await act(async () => root!.render(<WalletSection />))
    expect(host.textContent).toContain(record)
    if (phase === 'error') {
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('Showing previously loaded data')
      await act(async () => {
        host.querySelector<HTMLButtonElement>('[role="alert"] button')!.click()
      })
      expect(mocks.refetchHistory).toHaveBeenCalledOnce()
    }
  })

  it('keeps failed money histories distinct from empty records and retries', async () => {
    mocks.historiesError = true
    const host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRoot(host)
      root.render(<WalletSection />)
    })
    await flush()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not load billing history')
    expect(document.body.textContent).not.toContain('No billing documents yet')
    await act(async () => {
      ;[...document.querySelectorAll('button')].find((x) => x.textContent === 'Retry')!.click()
    })
    expect(mocks.refetchHistory).toHaveBeenCalledOnce()
    mocks.refetchHistory.mockClear()
    const creditTab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((x) =>
      x.textContent?.includes('Credit activity'),
    )!
    await act(async () => {
      creditTab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      creditTab.click()
    })
    await flush()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not load credit activity')
    expect(document.body.textContent).not.toContain('No credit activity yet')
    await act(async () => {
      ;[...document.querySelectorAll('button')].find((x) => x.textContent === 'Retry')!.click()
    })
    expect(mocks.refetchHistory).toHaveBeenCalledOnce()
  })

  it.each(['Billing history', 'Credit activity'])('returns from a failed later page in %s', async (tabName) => {
    mocks.failLaterPage = true
    const host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRoot(host)
      root.render(<WalletSection />)
    })
    await flush()
    if (tabName === 'Credit activity') {
      const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((el) =>
        el.textContent?.includes(tabName),
      )!
      await act(async () => {
        tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
        tab.click()
      })
    }
    await act(async () =>
      [...document.querySelectorAll('button')].find((button) => button.textContent === 'Next →')!.click(),
    )
    await flush()
    expect(document.querySelector('[role="alert"]')).not.toBeNull()
    const previous = [...document.querySelectorAll('button')].find((button) => button.textContent === '← Previous')
    expect(previous).toBeDefined()
    expect(previous?.disabled).toBe(false)
    expect(document.body.textContent).not.toContain('Page 2 of 0')
    await act(async () => previous!.click())
    await flush()
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(document.body.textContent).toContain(tabName === 'Billing history' ? 'BOX-2026-0002' : '2026-07-18')
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

    // Both counts are fetched up front — the number on the tab is what tells a
    // reader the ledger holds anything. Its rows wait until the tab is chosen.
    expect(mocks.walletTransactionsQuery).toHaveBeenCalledWith(1, DEFAULT_PAGE_SIZE)
    expect(document.body.textContent).not.toContain('2026-07-18')

    const creditTab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) =>
      tab.textContent?.includes('Credit activity'),
    )
    await act(async () => {
      creditTab?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      creditTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(document.body.textContent).toContain('2026-07-18')

    // Scoped to the open panel: both histories have a pager, and only the
    // visible one should be driven here.
    const creditPanel = document.querySelector('[role="tabpanel"][data-state="active"]')
    const nextPage = [...(creditPanel?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (button) => button.textContent?.trim() === 'Next →',
    )
    expect(nextPage).toBeDefined()

    await act(async () => nextPage?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()

    expect(mocks.walletTransactionsQuery).toHaveBeenLastCalledWith(2, DEFAULT_PAGE_SIZE)
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
    // The default card leads; the others keep the API's order.
    expect(rows[0].querySelector('img')?.getAttribute('src')).toBe(mastercardLogo)
    expect(rows[1].querySelector('img')?.getAttribute('src')).toBe(visaLogo)
    expect(rows[2].querySelector('[aria-label="CARD"]')).not.toBeNull()
    expect(list?.textContent).toContain('VISA')
    expect(list?.textContent).toContain('•••• 4242')
    expect(list?.textContent).toContain('exp 08/27')
    expect(list?.textContent).toContain('MASTERCARD')
    expect(list?.textContent).toContain('•••• 4444')
    expect(list?.textContent).toContain('exp 12/29')
    expect(list?.textContent).toContain('CARD')
    expect(list?.textContent).toContain('Saved card')
    expect(rows[0].textContent).toContain('Default')
    expect(rows[0].textContent).toContain('Your default card is used for subscription renewals and top-ups.')
    expect(rows[1].textContent).not.toContain('Default')
    // Only non-default cards carry actions; Update card is gone.
    expect(rows[0].querySelector('button')).toBeNull()
    expect(rows[1].querySelector('button[aria-label^="Actions for"]')).not.toBeNull()
    expect(rows[2].querySelector('button[aria-label^="Actions for"]')).not.toBeNull()
    expect([...document.querySelectorAll('button')].some((button) => button.textContent?.includes('Update card'))).toBe(
      false,
    )
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

  async function renderTopUpRow() {
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
    const discountRibbon = document.querySelector<HTMLElement>('[role="img"][aria-label$=" off"]')
    return { topUpButton, discountRibbon }
  }

  it('lays the top-up discount over Top up as a ribbon the click passes through', async () => {
    mocks.wallet.usageChargeMultiplier = '0.7000'

    const { topUpButton, discountRibbon } = await renderTopUpRow()

    expect(discountRibbon?.getAttribute('aria-label')).toBe('30% off')
    expect(discountRibbon?.textContent).toBe('30% OFF')
    // The ribbon's own clip box sits beside the button and lets clicks through.
    const clipBox = discountRibbon?.parentElement
    expect(clipBox?.previousElementSibling).toBe(topUpButton)
    expect(clipBox?.classList.contains('pointer-events-none')).toBe(true)
    // Clipping on the button's wrapper would cut off its focus outline.
    expect(topUpButton?.parentElement?.classList.contains('overflow-hidden')).toBe(false)
    // The ribbon must not rename the button for assistive technology.
    expect(topUpButton?.textContent?.trim()).toBe('Top up →')
    expect(topUpButton?.getAttribute('data-console-action')).toBe('top_up_wallet')
  })

  it('shows no discount ribbon without a top-up discount', async () => {
    mocks.wallet.usageChargeMultiplier = '1.0000'

    const { topUpButton, discountRibbon } = await renderTopUpRow()

    expect(topUpButton).toBeDefined()
    expect(discountRibbon).toBeNull()
  })

  it('offers neither Top up nor a ribbon before the wallet answers', async () => {
    mocks.walletPending = true

    const { topUpButton, discountRibbon } = await renderTopUpRow()

    expect(topUpButton).toBeUndefined()
    expect(discountRibbon).toBeNull()
  })

  it('keeps the ribbon beside a Top up that is busy with a request', async () => {
    mocks.wallet.usageChargeMultiplier = '0.7000'
    mocks.topUpPending = true

    const { topUpButton, discountRibbon } = await renderTopUpRow()

    expect(topUpButton?.disabled).toBe(true)
    expect(topUpButton?.querySelector('[role="status"]')).not.toBeNull()
    expect(discountRibbon?.parentElement?.previousElementSibling).toBe(topUpButton)
  })

  it('lets the owner retry the membership lookup before confirming a coupon link', async () => {
    mocks.membersStatus = 'error'
    mocks.refreshMembers.mockReset().mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce([])
    const { host, button, visit } = await renderCouponLink('ACME50')
    expect(host.textContent).toContain('Couldn’t verify your organization role.')
    await act(async () => button('Retry verification')!.click())
    expect(button('Claim reward')).toBeUndefined()
    await act(async () => button('Retry verification')!.click())
    expect(mocks.refreshMembers).toHaveBeenCalledTimes(2)
    mocks.membersStatus = 'ready'
    await visit('ACME50')
    expect(button('Claim reward')).toBeDefined()
    expect(mocks.claimCoupon).not.toHaveBeenCalled()
  })

  it('lets an owner enter a different coupon after a link is rejected', async () => {
    mocks.claimCoupon.mockRejectedValue(new Error('This coupon is expired'))
    mocks.redeemCoupon.mockResolvedValue('Coupon redeemed')
    const { host, button } = await renderCouponLink('EXPIRED')
    await act(async () => button('Claim reward')!.click())
    expect(host.textContent).toContain('This coupon is expired')
    expect(button('Have a coupon code?')).toBeDefined()
    await act(async () => button('Have a coupon code?')!.click())
    const manual = host.querySelector<HTMLInputElement>('input[placeholder="Enter coupon code"]:not([readonly])')!
    await act(async () => typeInto(manual, 'OTHER'))
    await act(async () => button('Redeem')!.click())
    expect(mocks.redeemCoupon).toHaveBeenCalledExactlyOnceWith({
      organizationId: mocks.organizationId,
      couponCode: 'OTHER',
    })
    expect(mocks.claimCoupon).toHaveBeenCalledTimes(1)
  })

  async function renderCouponLink(initialCode?: string) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const client = new QueryClient()
    let code = initialCode
    const onCouponClaimAccepted = vi.fn(() => {
      code = undefined
      render()
    })
    function render() {
      root!.render(
        <StrictMode>
          <QueryClientProvider client={client}>
            <WalletSection linkCouponCode={code} onCouponClaimAccepted={onCouponClaimAccepted} />
          </QueryClientProvider>
        </StrictMode>,
      )
    }
    async function visit(nextCode?: string, refresh = false) {
      code = nextCode
      await act(async () => {
        if (refresh) root?.unmount()
        if (refresh || !root) root = createRoot(host)
        render()
      })
    }
    await visit(initialCode)
    const button = (name: string) => [...host.querySelectorAll('button')].find((el) => el.textContent?.trim() === name)
    const input = () => host.querySelector<HTMLInputElement>('input[placeholder="Enter coupon code"]')
    return { host, button, input, visit, onCouponClaimAccepted, client }
  }

  it('submits a double-clicked coupon claim once for the selected organization and offers card setup after URL cleanup', async () => {
    mocks.claimCoupon.mockResolvedValue({ status: 'pending', result: null })
    const checkout = { location: { href: '' }, close: vi.fn() }
    vi.spyOn(window, 'open').mockReturnValue(checkout as unknown as Window)
    const { host, button, input, onCouponClaimAccepted } = await renderCouponLink('ACME50')
    expect(input()?.value).toBe('ACME50')
    expect(host.textContent).toContain('Acme Labs')
    expect(mocks.claimCoupon).not.toHaveBeenCalled()

    const claim = button('Claim reward')!
    await act(async () => {
      claim.click()
      claim.click()
    })
    expect(mocks.claimCoupon).toHaveBeenCalledExactlyOnceWith('org-without-card', {
      eventId: expect.any(String),
      couponCode: 'ACME50',
    })
    expect(mocks.redeemCoupon).not.toHaveBeenCalled()
    expect(onCouponClaimAccepted).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('Add a card soon to claim your reward.')
    await act(async () => button('Add card')!.click())
    expect(checkout.location.href).toBe('https://checkout.stripe.com/c/pay/cs_connect')
  })

  it('waits for the selected organization’s wallet before offering Add card', async () => {
    mocks.organizations = [{ id: mocks.organizationId }]
    mocks.walletPlaceholder = true
    mocks.claimCoupon.mockResolvedValue({ status: 'pending', result: null })
    const { host, button, visit } = await renderCouponLink('ACME50')
    expect(host.textContent).toContain('Your reward claim was received.')
    expect(button('Add card')).toBeUndefined()
    mocks.walletPlaceholder = false
    await visit()
    expect(host.textContent).toContain('Add a card soon to claim your reward.')
    expect(button('Add card')).toBeDefined()
  })

  it('shows the saved credit when the owner opens an already processed coupon link', async () => {
    mocks.organizations = [{ id: mocks.organizationId }]
    mocks.claimCoupon.mockResolvedValue({ status: 'done', result: { outcome: 'processed' } })
    const { host, button, onCouponClaimAccepted } = await renderCouponLink('ACME50')
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Reward credited.')
    expect(toast.success).toHaveBeenCalledExactlyOnceWith('Reward credited.')
    expect(onCouponClaimAccepted).toHaveBeenCalledOnce()
    expect(button('Claim reward')).toBeUndefined()
  })

  it('restores coupon claim outcomes on refresh and reuses the event ID after an unknown result', async () => {
    mocks.organizations = [{ id: mocks.organizationId }]
    mocks.wallet.creditCardConnected = true
    mocks.claimCoupon
      .mockRejectedValueOnce(new CouponClaimUnconfirmedError())
      .mockResolvedValueOnce({ status: 'pending', result: null })
      .mockResolvedValueOnce({ status: 'done', result: { outcome: 'processed' } })
    const { host, onCouponClaimAccepted, button, visit, client } = await renderCouponLink('ACME50')
    expect(mocks.claimCoupon).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('We couldn’t confirm your reward claim. Please try again.')
    expect(onCouponClaimAccepted).not.toHaveBeenCalled()
    await act(async () => button('Claim reward')!.click())
    expect(host.textContent).toContain('Your reward is being processed.')
    expect(button('Add card')).toBeUndefined()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    await visit(undefined, true)
    expect(host.textContent).toContain('Reward credited.')
    expect(invalidate).toHaveBeenCalled()
    expect(onCouponClaimAccepted).toHaveBeenCalledTimes(1)
    const calls = mocks.claimCoupon.mock.calls
    expect(calls).toHaveLength(3)
    expect(calls[0][1].eventId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(calls[1]).toEqual(calls[0])
    expect(calls[2]).toEqual(calls[0])
    expect(mocks.redeemCoupon).not.toHaveBeenCalled()
  })

  it.each([
    'Coupon not found',
    'This coupon is not available to this organization',
    'Coupon has already been redeemed',
    'This coupon is disabled',
    'This coupon is expired',
    'This coupon is exhausted',
    undefined,
  ])('retains the coupon link after a refusal without a receipt (%s)', async (reason) => {
    mocks.organizations = [{ id: mocks.organizationId }]
    mocks.claimCoupon.mockRejectedValue(reason ? new Error(reason) : undefined)
    const { input, host, onCouponClaimAccepted } = await renderCouponLink('NOPE')
    expect(mocks.claimCoupon).toHaveBeenCalledTimes(1)
    expect(input()?.value).toBe('NOPE')
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      ['Reward claim failed.', reason].filter(Boolean).join(' '),
    )
    expect(onCouponClaimAccepted).not.toHaveBeenCalled()
    expect(mocks.redeemCoupon).not.toHaveBeenCalled()
  })

  it.each([
    [
      { status: 'done', result: { outcome: 'skipped', reason: 'coupon_expired' } },
      'Reward claim failed. This coupon has expired.',
    ],
    [
      { status: 'done', result: { outcome: 'skipped', reason: 'coupon_unavailable' } },
      'Reward claim failed. coupon_unavailable',
    ],
    [{ status: 'failed', result: null }, 'Reward claim failed.'],
  ] as const)(
    'closes a terminal coupon claim and replays its receipt when the link is reopened (%j)',
    async (receipt, message) => {
      mocks.organizations = [{ id: mocks.organizationId }]
      mocks.claimCoupon.mockResolvedValue(receipt)
      const { host, button, visit, onCouponClaimAccepted } = await renderCouponLink('EXPIRED')
      expect(host.textContent).toContain(message)
      expect(button('Claim reward')).toBeUndefined()
      expect(onCouponClaimAccepted).toHaveBeenCalledTimes(1)
      expect(button('Have a coupon code?')).toBeDefined()
      await visit(undefined, true)
      expect(mocks.claimCoupon).toHaveBeenCalledTimes(1)
      await visit('EXPIRED')
      expect(mocks.claimCoupon).toHaveBeenCalledTimes(2)
      expect(mocks.claimCoupon.mock.calls[1]).toEqual(mocks.claimCoupon.mock.calls[0])
      expect(host.textContent).toContain(message)
      expect(button('Claim reward')).toBeUndefined()
    },
  )

  it('reuses a coupon claim identity across letter case and surrounding whitespace', async () => {
    mocks.organizations = [{ id: mocks.organizationId }]
    mocks.claimCoupon.mockRejectedValue(new CouponClaimUnconfirmedError())
    const { visit } = await renderCouponLink('  acme50  ')
    await visit('ACME50', true)
    expect(mocks.claimCoupon).toHaveBeenCalledTimes(2)
    expect(mocks.claimCoupon.mock.calls[1][1].eventId).toBe(mocks.claimCoupon.mock.calls[0][1].eventId)
  })

  it('recovers every pending coupon for this account and organization, retaining unconfirmed receipts across reloads', async () => {
    mocks.organizations = [{ id: mocks.organizationId }]
    const pending = { status: 'pending', result: null }
    mocks.claimCoupon.mockResolvedValue(pending)
    const { host, button, visit } = await renderCouponLink('FIRST')
    await visit('SECOND')
    const originalClaims = [...mocks.claimCoupon.mock.calls]
    expect(originalClaims.map(([, claim]) => claim.couponCode)).toEqual(['FIRST', 'SECOND'])
    mocks.claimCoupon.mockClear()
    mocks.accountId = 'another-owner'
    await visit(undefined, true)
    mocks.accountId = 'owner-1'
    mocks.organizationId = 'org-other'
    await visit(undefined, true)
    expect(mocks.claimCoupon).not.toHaveBeenCalled()
    expect(button('Add card')).toBeUndefined()

    mocks.organizationId = 'org-without-card'
    mocks.claimCoupon.mockImplementation((_org, claim) =>
      claim.couponCode === 'FIRST'
        ? Promise.resolve({ status: 'done', result: { outcome: 'skipped', reason: 'coupon_expired' } })
        : Promise.reject(new CouponClaimUnconfirmedError()),
    )
    await visit(undefined, true)
    expect(mocks.claimCoupon.mock.calls).toHaveLength(2)
    expect(mocks.claimCoupon.mock.calls).toEqual(expect.arrayContaining(originalClaims))
    expect(host.textContent).toContain('This coupon has expired.')
    expect(button('Claim reward')).toBeUndefined()
    expect(button('Add card')).toBeDefined()
    mocks.claimCoupon.mockClear().mockRejectedValue(new CouponClaimUnconfirmedError())
    await act(async () => button('Check again')!.click())
    expect(mocks.claimCoupon).toHaveBeenCalledExactlyOnceWith(...originalClaims[1])
    mocks.claimCoupon.mockClear().mockResolvedValue(pending)
    await visit(undefined, true)
    expect(mocks.claimCoupon).toHaveBeenCalledExactlyOnceWith(...originalClaims[1])
    expect(host.textContent).toContain('Add a card soon to claim your reward.')
  })

  it.each([
    [false, 'owner', 'ready', 'Verify your email'],
    [true, 'member', 'ready', 'owner'],
    [true, 'owner', 'loading', ''],
  ])(
    'gates coupon claims on verified email and current ownership (%s, %s, %s)',
    async (verified, role, status, prompt) => {
      mocks.emailVerified = verified as boolean
      mocks.memberRole = role as string
      mocks.membersStatus = status as string
      mocks.organizations = [{ id: mocks.organizationId }]
      mocks.walletPending = true
      const { host, button } = await renderCouponLink('ACME50')
      if (prompt) expect(host.textContent).toContain(prompt)
      expect(button('Claim reward')).toBeUndefined()
      expect(mocks.claimCoupon).not.toHaveBeenCalled()
      expect(mocks.redeemCoupon).not.toHaveBeenCalled()
    },
  )

  it.each(['processed', 'refused'])(
    'isolates a late %s claim after navigating to another code, organization and account',
    async (outcome) => {
      mocks.organizations = [{ id: mocks.organizationId }]
      let finish!: () => void
      mocks.claimCoupon.mockReturnValueOnce(
        new Promise((resolve, reject) => {
          finish = () =>
            outcome === 'processed'
              ? resolve({ status: 'done', result: { outcome: 'processed' } })
              : reject(new Error('First coupon expired'))
        }),
      )
      mocks.claimCoupon.mockRejectedValue(new Error('Coupon disabled'))
      const { host, visit, onCouponClaimAccepted, client } = await renderCouponLink('FIRST')
      const invalidate = vi.spyOn(client, 'invalidateQueries')
      await visit('SECOND')
      mocks.organizationId = 'org-other'
      mocks.organizations = [{ id: mocks.organizationId }]
      await visit('SECOND')
      mocks.accountId = 'owner-2'
      await visit('SECOND')
      vi.mocked(toast.error).mockClear()
      await act(async () => finish())
      if (outcome === 'processed') {
        expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.organization.wallet('org-without-card') })
        expect(invalidate).not.toHaveBeenCalledWith({ queryKey: queryKeys.organization.wallet('org-other') })
      }
      expect(toast.success).not.toHaveBeenCalled()
      expect(toast.error).not.toHaveBeenCalled()
      expect(onCouponClaimAccepted).not.toHaveBeenCalled()
      expect(host.textContent).toContain('Coupon disabled')
      expect(host.textContent).not.toContain('Reward credited.')
      expect(mocks.claimCoupon).toHaveBeenCalledTimes(4)
      const ids = mocks.claimCoupon.mock.calls.map(([, { eventId }]) => eventId)
      expect(new Set(ids).size).toBe(4)
    },
  )

  it('redeems independently entered Wallet coupon codes through Commerce', async () => {
    mocks.redeemCoupon.mockResolvedValue('Coupon redeemed')
    const { button, input, host } = await renderCouponLink()
    expect(input()).toBeNull()
    await act(async () => button('Have a coupon code?')!.click())
    await act(async () => typeInto(input()!, 'TeamDiscount'))
    await act(async () => button('Redeem')!.click())
    expect(mocks.redeemCoupon).toHaveBeenCalledExactlyOnceWith({
      organizationId: mocks.organizationId,
      couponCode: 'TeamDiscount',
    })
    expect(mocks.claimCoupon).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Coupon redeemed')
  })

  it('keeps independent Wallet coupon entry available when browser storage is disabled', async () => {
    vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new DOMException('Access to session storage is blocked', 'SecurityError')
    })
    mocks.redeemCoupon.mockResolvedValue('Coupon redeemed')
    const { button, input, host } = await renderCouponLink()
    await act(async () => button('Have a coupon code?')!.click())
    await act(async () => typeInto(input()!, 'TeamDiscount'))
    await act(async () => button('Redeem')!.click())
    expect(host.textContent).toContain('Coupon redeemed')
    expect(mocks.claimCoupon).not.toHaveBeenCalled()
  })

  describe('saved card management', () => {
    const card = (id: string, isDefault: boolean, last4: string) => ({
      id,
      isDefault,
      paymentProviderType: 'stripe' as const,
      providerMethodId: `pm_${id}`,
      details: { brand: 'visa', last4, expMonth: 8, expYear: 2027 },
    })

    async function renderWallet() {
      mocks.wallet.creditCardConnected = true
      const host = document.createElement('div')
      document.body.appendChild(host)
      await act(async () => {
        root = createRoot(host)
        root.render(<WalletSection />)
      })
      await flush()
    }

    async function openMenu(last4: string) {
      const trigger = document.querySelector<HTMLButtonElement>(`button[aria-label="Actions for VISA •••• ${last4}"]`)
      expect(trigger).not.toBeNull()
      // Radix opens menus on pointerdown; jsdom has no PointerEvent, and React reads only `button`.
      await act(async () =>
        trigger!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })),
      )
      return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    }

    const menuItem = (items: HTMLElement[], label: string) => items.find((item) => item.textContent === label)

    it('sets a non-default card as the default', async () => {
      mocks.paymentMethods = [card('card-default', true, '4242'), card('card-other', false, '1111')]
      await renderWallet()

      const items = await openMenu('1111')
      expect(items.map((item) => item.textContent)).toEqual(['Set as default', 'Remove'])
      await act(async () => menuItem(items, 'Set as default')!.click())
      await flush()

      expect(mocks.setDefaultPaymentMethod).toHaveBeenCalledExactlyOnceWith({
        organizationId: 'org-without-card',
        paymentMethodId: 'card-other',
      })
      expect(toast.error).not.toHaveBeenCalled()
    })

    it('removes a card only after the confirmation dialog', async () => {
      mocks.paymentMethods = [card('card-default', true, '4242'), card('card-other', false, '1111')]
      await renderWallet()

      await act(async () => menuItem(await openMenu('1111'), 'Remove')!.click())
      await flush()

      const dialog = document.querySelector('[role="alertdialog"]')
      expect(dialog?.textContent).toContain('Remove VISA •••• 1111?')
      expect(mocks.removePaymentMethod).not.toHaveBeenCalled()

      const confirm = [...dialog!.querySelectorAll('button')].find((button) => button.textContent === 'Remove')
      await act(async () => confirm!.click())
      await flush()

      expect(mocks.removePaymentMethod).toHaveBeenCalledExactlyOnceWith({
        organizationId: 'org-without-card',
        paymentMethodId: 'card-other',
      })
      expect(toast.error).not.toHaveBeenCalled()
    })

    it('closes the removal confirmation when its card becomes the default', async () => {
      mocks.paymentMethods = [card('card-default', true, '4242'), card('card-other', false, '1111')]
      await renderWallet()

      await act(async () => menuItem(await openMenu('1111'), 'Remove')!.click())
      await flush()
      expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()

      // A set-default request for the same card lands while the dialog is open.
      mocks.paymentMethods = [card('card-default', false, '4242'), card('card-other', true, '1111')]
      await act(async () => root!.render(<WalletSection />))
      await flush()
      expect(document.querySelector('[role="alertdialog"]')).toBeNull()

      // Losing the default again must not reopen the abandoned confirmation.
      mocks.paymentMethods = [card('card-default', true, '4242'), card('card-other', false, '1111')]
      await act(async () => root!.render(<WalletSection />))
      await flush()
      expect(document.querySelector('[role="alertdialog"]')).toBeNull()
      expect(mocks.removePaymentMethod).not.toHaveBeenCalled()
    })

    it('offers no action on the default card', async () => {
      mocks.paymentMethods = [card('card-default', true, '4242')]
      await renderWallet()

      expect(document.querySelector('button[aria-label^="Actions for"]')).toBeNull()
    })

    it('reports a failed action and leaves the list as it was', async () => {
      mocks.paymentMethods = [card('card-default', true, '4242'), card('card-other', false, '1111')]
      mocks.setDefaultPaymentMethod.mockRejectedValue(new Error('Request failed with status code 404'))
      await renderWallet()

      await act(async () => menuItem(await openMenu('1111'), 'Set as default')!.click())
      await flush()

      expect(toast.error).toHaveBeenCalledWith('Failed to set the default card', {
        description: 'Error: Request failed with status code 404',
      })
      const rows = [...document.querySelectorAll('ul[aria-label="Saved payment methods"] li')]
      expect(rows.map((row) => row.textContent?.includes('Default'))).toEqual([true, false])
      expect(rows[0].textContent).toContain('•••• 4242')
    })

    it('reports a failed removal and keeps the card listed', async () => {
      mocks.paymentMethods = [card('card-default', true, '4242'), card('card-other', false, '1111')]
      mocks.removePaymentMethod.mockRejectedValue(new Error('Request failed with status code 404'))
      await renderWallet()

      await act(async () => menuItem(await openMenu('1111'), 'Remove')!.click())
      await flush()
      const confirm = [...document.querySelectorAll('[role="alertdialog"] button')].find(
        (button) => button.textContent === 'Remove',
      ) as HTMLButtonElement
      await act(async () => confirm.click())
      await flush()

      expect(toast.error).toHaveBeenCalledWith('Failed to remove the card', {
        description: 'Error: Request failed with status code 404',
      })
      const rows = [...document.querySelectorAll('ul[aria-label="Saved payment methods"] li')]
      expect(rows).toHaveLength(2)
      expect(rows[1].textContent).toContain('•••• 1111')
    })
  })
})
