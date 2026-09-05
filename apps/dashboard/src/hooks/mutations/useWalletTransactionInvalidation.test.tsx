// @vitest-environment jsdom
/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '../queries/queryKeys'
import { useRedeemCouponMutation } from './useRedeemCouponMutation'
import { useTopUpWalletMutation } from './useTopUpWalletMutation'

const mocks = vi.hoisted(() => ({
  redeemCoupon: vi.fn(),
  topUpWallet: vi.fn(),
}))

vi.mock('@/hooks/useApi', () => ({
  useApi: () => ({ billingApi: mocks }),
}))

let redeemCoupon: ReturnType<typeof useRedeemCouponMutation> | undefined
let topUpWallet: ReturnType<typeof useTopUpWalletMutation> | undefined

function WalletMutationProbe() {
  redeemCoupon = useRedeemCouponMutation()
  topUpWallet = useTopUpWalletMutation()
  return null
}

describe('wallet transaction invalidation', () => {
  let queryClient: QueryClient
  let invalidateQueries: ReturnType<typeof vi.spyOn>
  let root: Root | null = null

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries')
    mocks.redeemCoupon.mockResolvedValue('redeemed')
    mocks.topUpWallet.mockResolvedValue({ url: 'https://checkout.example.test/session' })

    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <WalletMutationProbe />
        </QueryClientProvider>,
      )
    })
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    redeemCoupon = undefined
    topUpWallet = undefined
    queryClient.clear()
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  it('refreshes every transaction page after a top-up', async () => {
    await act(async () => {
      await topUpWallet?.mutateAsync({ organizationId: 'org-1', amountCents: 500 })
    })

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.billing.transactions('org-1') })
  })

  it('refreshes every transaction page after a coupon redemption', async () => {
    await act(async () => {
      await redeemCoupon?.mutateAsync({ organizationId: 'org-1', couponCode: 'SAVE10' })
    })

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.billing.transactions('org-1') })
  })

  it('refreshes the billing history after a top-up, not only the credit ledger', async () => {
    // A top-up now mints its own document. Leaving the invoice key out would
    // hold the primary section on stale data for the 5-minute staleTime while
    // the ledger folded beneath it refreshed immediately.
    await act(async () => {
      await topUpWallet?.mutateAsync({ organizationId: 'org-1', amountCents: 500 })
    })

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.billing.invoices('org-1') })
  })

  it('refreshes the billing history after a coupon redemption', async () => {
    await act(async () => {
      await redeemCoupon?.mutateAsync({ organizationId: 'org-1', couponCode: 'SAVE10' })
    })

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.billing.invoices('org-1') })
  })

  it('shares one prefix between the filtered listing and the invalidation key', () => {
    // Invalidation only reaches the listing if its key is a prefix of it; a
    // separate shape would silently no-op.
    const prefix = queryKeys.billing.invoices('org-1')
    const listing = queryKeys.billing.invoices('org-1', 'all', 1, 100)

    expect(listing.slice(0, prefix.length)).toEqual([...prefix])
  })
})
