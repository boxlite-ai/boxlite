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
import { useUpgradePlanMutation } from './useUpgradePlanMutation'

const mocks = vi.hoisted(() => ({
  upgradePlan: vi.fn(),
}))

vi.mock('@/hooks/useApi', () => ({
  useApi: () => ({ billingApi: mocks }),
}))

let upgradePlan: ReturnType<typeof useUpgradePlanMutation> | undefined

function UpgradePlanProbe() {
  upgradePlan = useUpgradePlanMutation()
  return null
}

/**
 * An in-place upgrade restarts the billing cycle, so the cycle window and the
 * included allowance both move at the moment it applies. The plan block and
 * the wallet are rendered side by side (ThisCycleCard, CycleOverview), so a
 * wallet left cached states a stale balance beside the new quota.
 */
describe('useUpgradePlanMutation', () => {
  let queryClient: QueryClient
  let invalidateQueries: ReturnType<typeof vi.spyOn>
  let root: Root | null = null

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries')
    mocks.upgradePlan.mockResolvedValue(undefined)

    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <UpgradePlanProbe />
        </QueryClientProvider>,
      )
    })
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    upgradePlan = undefined
    queryClient.clear()
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  it('refreshes the plan block and the wallet after an upgrade applies in place', async () => {
    await act(async () => {
      await upgradePlan?.mutateAsync({ organizationId: 'org-1', planId: 'max' })
    })

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.organization.plan('org-1') })
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.organization.wallet('org-1') })
  })
})
