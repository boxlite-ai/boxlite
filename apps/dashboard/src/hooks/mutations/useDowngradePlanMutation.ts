/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../queries/queryKeys'
import { useApi } from '../useApi'

interface DowngradePlanParams {
  organizationId: string
  /** null cancels the subscription outright. */
  planId: string | null
}

export const useDowngradePlanMutation = () => {
  const { billingApi } = useApi()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ organizationId, planId }: DowngradePlanParams) => billingApi.downgradePlan(organizationId, planId),
    onSuccess: async (_data, { organizationId }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.organization.plan(organizationId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.organization.usage.overview(organizationId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.billing.transactions(organizationId) }),
      ])
    },
  })
}
