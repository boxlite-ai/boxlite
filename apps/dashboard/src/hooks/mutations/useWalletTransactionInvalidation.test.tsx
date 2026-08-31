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
})
