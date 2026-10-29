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
import { useDowngradePlanMutation } from './useDowngradePlanMutation'
import { useKeepPlanMutation } from './useKeepPlanMutation'

const mocks = vi.hoisted(() => ({
  upgradePlan: vi.fn(),
  downgradePlan: vi.fn(),
  withdrawPendingPlan: vi.fn(),
}))

vi.mock('@/hooks/useApi', () => ({
  useApi: () => ({ billingApi: mocks }),
}))

let upgradePlan: ReturnType<typeof useUpgradePlanMutation> | undefined
let downgradePlan: ReturnType<typeof useDowngradePlanMutation> | undefined
let keepPlan: ReturnType<typeof useKeepPlanMutation> | undefined

function UpgradePlanProbe() {
  upgradePlan = useUpgradePlanMutation()
  downgradePlan = useDowngradePlanMutation()
  keepPlan = useKeepPlanMutation()
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

  it.each(['upgrade', 'downgrade', 'keep'] as const)(
    'refreshes the changed organization limits after %s without waiting for that read',
    async (action) => {
      invalidateQueries.mockImplementation(({ queryKey }) =>
        JSON.stringify(queryKey) === JSON.stringify(queryKeys.organization.detail('org-1'))
          ? new Promise(() => undefined)
          : Promise.resolve(),
      )
      let completed = false
      await act(async () => {
        const params = { organizationId: 'org-1', planId: 'pro' }
        const result =
          action === 'upgrade'
            ? upgradePlan?.mutateAsync(params)
            : action === 'downgrade'
              ? downgradePlan?.mutateAsync(params)
              : keepPlan?.mutateAsync({ ...params, kind: 'cancel' })
        void result?.then(() => {
          completed = true
        })
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.organization.detail('org-1') })
      expect(completed).toBe(true)
    },
  )

  it('refreshes the plan block and the wallet after an upgrade applies in place', async () => {
    await act(async () => {
      await upgradePlan?.mutateAsync({ organizationId: 'org-1', planId: 'max' })
    })

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.organization.plan('org-1') })
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.organization.wallet('org-1') })
  })
})
