/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../queries/queryKeys'
import { useApi } from '../useApi'

interface KeepPlanParams {
  organizationId: string
  /** The plan the organization is already on — the one being kept. */
  planId: string
  kind: 'downgrade' | 'cancel'
}

/**
 * Discards whatever is queued against the current cycle (a downgrade, or a
 * cancellation) and stays on the live plan.
 *
 * The two scheduled states are separate Commerce lifecycles. A queued
 * downgrade has its own successor row, withdrawn through `plan/pending`. A
 * scheduled cancellation marks the effective row canceled, so re-asserting
 * that same plan through the upgrade path is Commerce's reactivation command.
 * Keep that routing here so the button does not need to know either wire API.
 */
export const useKeepPlanMutation = () => {
  const { billingApi } = useApi()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ organizationId, planId, kind }: KeepPlanParams): Promise<string | undefined> => {
      if (kind === 'downgrade') {
        await billingApi.withdrawPendingPlan(organizationId)
        return undefined
      }
      return billingApi.upgradePlan(organizationId, planId)
    },
    onSuccess: async (_data, { organizationId }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.organization.plan(organizationId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.organization.usage.overview(organizationId) }),
      ])
    },
  })
}
