/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { BillingPaymentSetupResult } from '@/billing-api'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../queries/queryKeys'
import { useApi } from '../useApi'

export function useSetupBillingPaymentMutation() {
  const { billingApi } = useApi()
  const queryClient = useQueryClient()

  return useMutation<BillingPaymentSetupResult, unknown, { organizationId: string }>({
    mutationFn: ({ organizationId }) => billingApi.setupBillingPayment(organizationId),
    onSuccess: async (result, { organizationId }) => {
      if (result.checkoutUrl) return
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.billing.payment(organizationId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.billing.overviewRoot(organizationId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.billing.receiptsRoot(organizationId) }),
      ])
    },
  })
}
