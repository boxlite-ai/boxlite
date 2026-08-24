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
}

/**
 * Discards whatever is queued against the current cycle (a downgrade, or a
 * cancellation) and stays on the live plan.
 *
 * Commerce exposes no "clear the pending change" route, so this re-asserts the
 * plan the organization already holds and relies on the upgrade path treating
 * that as "cancel what is scheduled". That is the only expression the current
 * contract allows:
 *
 *   - `downgradePlan(id, planId)` would queue a change *to the current plan*
 *     rather than clear one.
 *   - `downgradePlan(id, null)` cancels the subscription outright — the exact
 *     opposite of this action, and the reason this lives behind its own hook
 *     rather than being spelled out at the call site.
 *
 * If commerce ever grows an explicit route (`DELETE .../plan/pending`), this
 * hook is the only thing that changes.
 */
export const useKeepPlanMutation = () => {
  const { billingApi } = useApi()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ organizationId, planId }: KeepPlanParams) => billingApi.upgradePlan(organizationId, planId),
    onSuccess: async (_data, { organizationId }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.organization.plan(organizationId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.organization.usage.overview(organizationId) }),
      ])
    },
  })
}
