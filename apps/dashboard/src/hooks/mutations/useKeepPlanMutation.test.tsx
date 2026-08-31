// @vitest-environment jsdom
/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useKeepPlanMutation } from './useKeepPlanMutation'

const mocks = vi.hoisted(() => ({
  upgradePlan: vi.fn(),
  withdrawPendingPlan: vi.fn(),
}))

vi.mock('@/hooks/useApi', () => ({
  useApi: () => ({ billingApi: mocks }),
}))

let keepPlan: ReturnType<typeof useKeepPlanMutation> | undefined

function KeepPlanProbe() {
  keepPlan = useKeepPlanMutation()
  return null
}

describe('useKeepPlanMutation', () => {
  let queryClient: QueryClient
  let root: Root | null = null

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    mocks.upgradePlan.mockResolvedValue(undefined)
    mocks.withdrawPendingPlan.mockResolvedValue(undefined)

    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <KeepPlanProbe />
        </QueryClientProvider>,
      )
    })
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    keepPlan = undefined
    queryClient.clear()
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  it('withdraws the queued plan instead of upgrading to the effective plan again', async () => {
    await act(async () => {
      await keepPlan?.mutateAsync({ organizationId: 'org-1', planId: 'pro', kind: 'downgrade' })
    })

    expect(mocks.withdrawPendingPlan).toHaveBeenCalledWith('org-1')
    expect(mocks.upgradePlan).not.toHaveBeenCalled()
  })

  it('still reactivates a scheduled cancellation through the effective plan', async () => {
    await act(async () => {
      await keepPlan?.mutateAsync({ organizationId: 'org-1', planId: 'pro', kind: 'cancel' })
    })

    expect(mocks.upgradePlan).toHaveBeenCalledWith('org-1', 'pro')
    expect(mocks.withdrawPendingPlan).not.toHaveBeenCalled()
  })

  it('preserves a checkout URL when a stale cancellation has already ended', async () => {
    mocks.upgradePlan.mockResolvedValueOnce('https://checkout.example.test/session')

    let checkoutUrl: string | undefined
    await act(async () => {
      checkoutUrl = await keepPlan?.mutateAsync({ organizationId: 'org-1', planId: 'pro', kind: 'cancel' })
    })

    expect(checkoutUrl).toBe('https://checkout.example.test/session')
  })
})
