// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '../queries/queryKeys'
import { useRemovePaymentMethodMutation } from './useRemovePaymentMethodMutation'
import { useSetDefaultPaymentMethodMutation } from './useSetDefaultPaymentMethodMutation'

const mocks = vi.hoisted(() => ({
  setDefaultPaymentMethod: vi.fn(),
  removePaymentMethod: vi.fn(),
}))

vi.mock('@/hooks/useApi', () => ({
  useApi: () => ({ billingApi: mocks }),
}))

let setDefault: ReturnType<typeof useSetDefaultPaymentMethodMutation> | undefined
let remove: ReturnType<typeof useRemovePaymentMethodMutation> | undefined

function PaymentMethodMutationProbe() {
  setDefault = useSetDefaultPaymentMethodMutation()
  remove = useRemovePaymentMethodMutation()
  return null
}

describe('saved card mutations', () => {
  let queryClient: QueryClient
  let invalidateQueries: ReturnType<typeof vi.spyOn>
  let root: Root | null = null

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries')
    mocks.setDefaultPaymentMethod.mockResolvedValue(undefined)
    mocks.removePaymentMethod.mockResolvedValue(undefined)

    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <PaymentMethodMutationProbe />
        </QueryClientProvider>,
      )
    })
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    setDefault = undefined
    remove = undefined
    queryClient.clear()
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  const refreshedKeys = [
    queryKeys.billing.paymentMethods('org-1'),
    queryKeys.organization.wallet('org-1'),
    queryKeys.organization.plan('org-1'),
  ]

  it('refreshes cards, wallet and plan after setting the default card', async () => {
    await act(async () => {
      await setDefault?.mutateAsync({ organizationId: 'org-1', paymentMethodId: 'card-2' })
    })

    expect(mocks.setDefaultPaymentMethod).toHaveBeenCalledWith('org-1', 'card-2')
    for (const queryKey of refreshedKeys) expect(invalidateQueries).toHaveBeenCalledWith({ queryKey })
  })

  it('refreshes cards, wallet and plan after removing a card', async () => {
    await act(async () => {
      await remove?.mutateAsync({ organizationId: 'org-1', paymentMethodId: 'card-2' })
    })

    expect(mocks.removePaymentMethod).toHaveBeenCalledWith('org-1', 'card-2')
    for (const queryKey of refreshedKeys) expect(invalidateQueries).toHaveBeenCalledWith({ queryKey })
  })
})
