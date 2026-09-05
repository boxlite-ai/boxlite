/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../queries/queryKeys'
import { useApi } from '../useApi'

interface UpgradePlanParams {
  organizationId: string
  planId: string
}

/** Resolves to a Checkout URL for a first subscribe, or undefined when the change already applied. */
export const useUpgradePlanMutation = () => {
  const { billingApi } = useApi()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ organizationId, planId }: UpgradePlanParams) => billingApi.upgradePlan(organizationId, planId),
    onSuccess: async (_data, { organizationId }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.organization.plan(organizationId) }),
        // The upgrade path reconciles subscription credit and invalidates the
        // available balance (boxlite-commerce upgrade-subscription.ts,
        // finish-upgrade.ts), so the wallet moves with the plan block — and the
        // two are read side by side (ThisCycleCard, CycleOverview).
        queryClient.invalidateQueries({ queryKey: queryKeys.organization.wallet(organizationId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.organization.usage.overview(organizationId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.billing.transactions(organizationId) }),
      ])
    },
  })
}
