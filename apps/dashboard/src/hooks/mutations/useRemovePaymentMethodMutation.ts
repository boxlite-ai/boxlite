/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../queries/queryKeys'
import { useApi } from '../useApi'

interface RemovePaymentMethodVariables {
  organizationId: string
  paymentMethodId: string
}

export const useRemovePaymentMethodMutation = () => {
  const { billingApi } = useApi()
  const queryClient = useQueryClient()

  return useMutation<void, unknown, RemovePaymentMethodVariables>({
    mutationFn: ({ organizationId, paymentMethodId }) => billingApi.removePaymentMethod(organizationId, paymentMethodId),
    onSuccess: async (_data, { organizationId }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.billing.paymentMethods(organizationId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.organization.wallet(organizationId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.organization.plan(organizationId) }),
      ])
    },
  })
}
