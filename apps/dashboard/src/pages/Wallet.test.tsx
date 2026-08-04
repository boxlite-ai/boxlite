// @vitest-environment jsdom
/*
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Wallet from './Wallet'

const mocks = vi.hoisted(() => ({
  walletQuery: { data: undefined as unknown, isLoading: false },
  billingPortalUrlQuery: { data: undefined as unknown, isLoading: false },
  invoicesQuery: { data: undefined as unknown, isLoading: false },
}))

vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({ selectedOrganization: { id: 'org-1', isDefaultForAuthenticatedUser: true } }),
}))

vi.mock('react-oidc-context', () => ({
  useAuth: () => ({ user: { profile: { email_verified: true } } }),
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// PageLayout renders BannerStack, which needs a BannerProvider this test
// doesn't set up -- irrelevant to what's under test here, so stub it with
// plain passthrough containers.
vi.mock('@/components/PageLayout', () => ({
  PageLayout: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  PageHeader: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  PageContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  PageTitle: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}))

vi.mock('@/hooks/queries/billingQueries', () => ({
  useOwnerWalletQuery: () => mocks.walletQuery,
  useOwnerBillingPortalUrlQuery: () => mocks.billingPortalUrlQuery,
  useOwnerInvoicesQuery: () => mocks.invoicesQuery,
  useIsOwnerCheckoutUrlFetching: () => false,
  useFetchOwnerCheckoutUrlQuery: () => vi.fn(),
}))

vi.mock('@/hooks/mutations/useCreateInvoicePaymentUrlMutation', () => ({
  useCreateInvoicePaymentUrlMutation: () => ({ mutateAsync: vi.fn() }),
}))
vi.mock('@/hooks/mutations/useRedeemCouponMutation', () => ({
  useRedeemCouponMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))
vi.mock('@/hooks/mutations/useSetAutomaticTopUpMutation', () => ({
  useSetAutomaticTopUpMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))
vi.mock('@/hooks/mutations/useTopUpWalletMutation', () => ({
  useTopUpWalletMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))
vi.mock('@/hooks/mutations/useVoidInvoiceMutation', () => ({
  useVoidInvoiceMutation: () => ({ mutateAsync: vi.fn() }),
}))

// InvoicesTable pulls in Pagination -> useIsMobile -> window.matchMedia, which
// jsdom doesn't implement. Irrelevant to the branch under test here.
vi.mock('@/components/Invoices', () => ({
  InvoicesTable: () => null,
}))

async function flushReactWork() {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('Wallet', () => {
  let root: Root | null = null

  beforeEach(() => {
    mocks.walletQuery.data = undefined
    mocks.walletQuery.isLoading = false
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    root = null
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  async function renderWallet() {
    const host = document.createElement('div')
    document.body.appendChild(host)

    await act(async () => {
      root = createRoot(host)
      root.render(<Wallet />)
    })

    await flushReactWork()
  }

  it('shows a get-started card instead of a blank page when no wallet exists yet', async () => {
    await renderWallet()

    expect(document.body.textContent).toContain('Get started with billing')
    expect(document.body.textContent).not.toContain('Current balance')
  })

  it('shows the real wallet content once the wallet loads, not the get-started card', async () => {
    mocks.walletQuery.data = {
      balanceCents: 1000,
      ongoingBalanceCents: 900,
      creditCardConnected: false,
      hasFailedOrPendingInvoice: false,
    }

    await renderWallet()

    expect(document.body.textContent).toContain('Current balance')
    expect(document.body.textContent).not.toContain('Get started with billing')
  })

  it('does not show the get-started card while the initial fetch is still in flight', async () => {
    mocks.walletQuery.isLoading = true

    await renderWallet()

    expect(document.body.textContent).not.toContain('Get started with billing')
  })
})
