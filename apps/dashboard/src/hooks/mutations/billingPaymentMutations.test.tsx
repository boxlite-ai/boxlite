// @vitest-environment jsdom
/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { BillingAutoReload, BillingPaymentSetupResult, BillingTopUpResult } from '@/billing-api'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '../queries/queryKeys'
import { useCreateBillingTopUpMutation } from './useCreateBillingTopUpMutation'
import { useSetupBillingPaymentMutation } from './useSetupBillingPaymentMutation'
import { useUpdateBillingAutoReloadMutation } from './useUpdateBillingAutoReloadMutation'

const state = vi.hoisted(() => ({
  setupPayment: vi.fn(),
  createTopUp: vi.fn(),
  updateAutoReload: vi.fn(),
}))

vi.mock('@/hooks/useApi', () => ({
  useApi: () => ({
    billingApi: {
      setupBillingPayment: state.setupPayment,
      createBillingTopUp: state.createTopUp,
      updateBillingAutoReload: state.updateAutoReload,
    },
  }),
}))

interface MutationRunners {
  setup: (variables: { organizationId: string }) => Promise<BillingPaymentSetupResult>
  topUp: (variables: { organizationId: string; amountCents: string }) => Promise<BillingTopUpResult>
  autoReload: (variables: { organizationId: string; autoReload: BillingAutoReload }) => Promise<void>
}

describe('billing payment mutations', () => {
  let root: Root | null = null
  let queryClient: QueryClient
  let runners: MutationRunners | null = null

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
    state.setupPayment.mockReset()
    state.createTopUp.mockReset()
    state.updateAutoReload.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    runners = null
    queryClient.clear()
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  function Harness({ children }: { children?: ReactNode }) {
    const setup = useSetupBillingPaymentMutation()
    const topUp = useCreateBillingTopUpMutation()
    const autoReload = useUpdateBillingAutoReloadMutation()
    runners = {
      setup: (variables) => setup.mutateAsync(variables),
      topUp: (variables) => topUp.mutateAsync(variables),
      autoReload: (variables) => autoReload.mutateAsync(variables),
    }
    return children
  }

  async function renderHarness() {
    const host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRoot(host)
      root.render(
        <QueryClientProvider client={queryClient}>
          <Harness />
        </QueryClientProvider>,
      )
    })
    if (!runners) throw new Error('Mutation harness did not initialize')
    return runners
  }

  it('invalidates payment, overview, and receipt roots when setup finishes without a checkout URL', async () => {
    state.setupPayment.mockResolvedValue({ status: 'ready', checkoutUrl: null })
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined)
    const mutations = await renderHarness()

    await act(async () => {
      await mutations.setup({ organizationId: 'org-1' })
    })

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.billing.payment('org-1') })
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.billing.overviewRoot('org-1') })
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.billing.receiptsRoot('org-1') })
  })

  it('invalidates the same roots after an immediate top-up result', async () => {
    state.createTopUp.mockResolvedValue({ id: 'top-up-1', status: 'paid', checkoutUrl: null })
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined)
    const mutations = await renderHarness()

    await act(async () => {
      await mutations.topUp({ organizationId: 'org-1', amountCents: '2500' })
    })

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.billing.payment('org-1') })
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.billing.overviewRoot('org-1') })
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.billing.receiptsRoot('org-1') })
  })

  it('reuses one idempotency key when an ambiguous top-up request is retried', async () => {
    state.createTopUp
      .mockRejectedValueOnce(new Error('provider response was lost'))
      .mockResolvedValueOnce({ id: 'top-up-1', status: 'paid', checkoutUrl: null })
    const mutations = await renderHarness()
    const variables = { organizationId: 'org-1', amountCents: '2500' }

    await act(async () => {
      await expect(mutations.topUp(variables)).rejects.toThrow('provider response was lost')
    })
    await act(async () => {
      await mutations.topUp(variables)
    })

    const firstKey = state.createTopUp.mock.calls[0]?.[2]
    expect(firstKey).toEqual(expect.any(String))
    expect(state.createTopUp).toHaveBeenNthCalledWith(2, 'org-1', '2500', firstKey)
  })

  it('starts a new idempotency scope after a top-up succeeds', async () => {
    state.createTopUp.mockResolvedValue({ id: 'top-up-1', status: 'paid', checkoutUrl: null })
    const mutations = await renderHarness()
    const variables = { organizationId: 'org-1', amountCents: '2500' }

    await act(async () => {
      await mutations.topUp(variables)
      await mutations.topUp(variables)
    })

    const firstKey = state.createTopUp.mock.calls[0]?.[2]
    const secondKey = state.createTopUp.mock.calls[1]?.[2]
    expect(firstKey).toEqual(expect.any(String))
    expect(secondKey).toEqual(expect.any(String))
    expect(secondKey).not.toBe(firstKey)
  })

  it('does not invalidate before checkout and refreshes payment after auto-reload saves', async () => {
    state.setupPayment.mockResolvedValue({ status: 'pending', checkoutUrl: 'https://checkout.test/setup' })
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined)
    const mutations = await renderHarness()

    await act(async () => {
      await mutations.setup({ organizationId: 'org-1' })
    })
    expect(invalidateQueries).not.toHaveBeenCalled()

    await act(async () => {
      await mutations.autoReload({
        organizationId: 'org-1',
        autoReload: { enabled: false, thresholdCents: null, targetCents: null },
      })
    })
    expect(invalidateQueries).toHaveBeenCalledOnce()
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.billing.payment('org-1') })
  })
})
