/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { BillingAutoReload } from '@/billing-api'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../queries/queryKeys'
import { useApi } from '../useApi'

interface UpdateBillingAutoReloadVariables {
  organizationId: string
  autoReload: BillingAutoReload
}

export function useUpdateBillingAutoReloadMutation() {
  const { billingApi } = useApi()
  const queryClient = useQueryClient()

  return useMutation<void, unknown, UpdateBillingAutoReloadVariables>({
    mutationFn: ({ organizationId, autoReload }) => billingApi.updateBillingAutoReload(organizationId, autoReload),
    onSuccess: async (_result, { organizationId }) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.billing.payment(organizationId) })
    },
  })
}
