// @vitest-environment jsdom
/*
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxliteError } from '@/api/errors'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedeemCouponMutation } from './useRedeemCouponMutation'
import { useTopUpWalletMutation } from './useTopUpWalletMutation'

const mocks = vi.hoisted(() => ({
  redeemCoupon: vi.fn(),
  topUpWallet: vi.fn(),
}))

vi.mock('@/hooks/useApi', () => ({
  useApi: () => ({
    billingApi: {
      redeemCoupon: mocks.redeemCoupon,
      topUpWallet: mocks.topUpWallet,
    },
  }),
}))

const topUpKey = '11111111-1111-4111-8111-111111111111'
const couponKey = '22222222-2222-4222-8222-222222222222'

let runTopUp: (() => Promise<unknown>) | undefined
let runCoupon: (() => Promise<unknown>) | undefined

function MutationProbe() {
  const topUp = useTopUpWalletMutation()
  const coupon = useRedeemCouponMutation()

  runTopUp = () =>
    topUp.mutateAsync({
      organizationId: 'org-1',
      amountCents: 5_000,
      idempotencyKey: topUpKey,
    })
  runCoupon = () =>
    coupon.mutateAsync({
      organizationId: 'org-1',
      couponCode: 'SAVE10',
      idempotencyKey: couponKey,
    })

  return null
}

function lostResponseError(): BoxliteError {
  const cause = Object.assign(new Error('Network Error'), { isAxiosError: true })
  return BoxliteError.fromString('Network Error', { cause })
}

describe('idempotent billing mutation retries', () => {
  let root: Root | null = null
  let queryClient: QueryClient

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(async () => {
    queryClient = new QueryClient({
      defaultOptions: {
        mutations: {
          retryDelay: 0,
        },
      },
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)

    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <MutationProbe />
        </QueryClientProvider>,
      )
    })
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    root = null
    queryClient.clear()
    runTopUp = undefined
    runCoupon = undefined
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  it('reuses one key when a wallet top-up is retried after a lost response', async () => {
    mocks.topUpWallet.mockRejectedValueOnce(lostResponseError()).mockResolvedValueOnce({
      url: 'https://checkout.test/top-up',
    })

    await act(async () => {
      await runTopUp?.()
    })

    expect(mocks.topUpWallet).toHaveBeenCalledTimes(2)
    expect(mocks.topUpWallet).toHaveBeenNthCalledWith(1, 'org-1', 5_000, topUpKey)
    expect(mocks.topUpWallet).toHaveBeenNthCalledWith(2, 'org-1', 5_000, topUpKey)
  })

  it('reuses one key when coupon redemption is retried after a lost response', async () => {
    mocks.redeemCoupon.mockRejectedValueOnce(lostResponseError()).mockResolvedValueOnce('Coupon redeemed')

    await act(async () => {
      await runCoupon?.()
    })

    expect(mocks.redeemCoupon).toHaveBeenCalledTimes(2)
    expect(mocks.redeemCoupon).toHaveBeenNthCalledWith(1, 'org-1', 'SAVE10', couponKey)
    expect(mocks.redeemCoupon).toHaveBeenNthCalledWith(2, 'org-1', 'SAVE10', couponKey)
  })
})
