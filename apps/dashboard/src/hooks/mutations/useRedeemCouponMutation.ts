/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../queries/queryKeys'
import { useApi } from '../useApi'

interface RedeemCouponVariables {
  organizationId: string
  couponCode: string
}

export function invalidateCouponQueries(queryClient: QueryClient, organizationId: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.organization.wallet(organizationId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.billing.transactions(organizationId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.billing.invoices(organizationId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.organization.plan(organizationId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.organization.usage.overview(organizationId) }),
  ])
}

export const useRedeemCouponMutation = () => {
  const { billingApi } = useApi()
  const queryClient = useQueryClient()

  return useMutation<string, unknown, RedeemCouponVariables>({
    mutationFn: ({ organizationId, couponCode }) => billingApi.redeemCoupon(organizationId, couponCode),
    onSuccess: (_data, { organizationId }) => invalidateCouponQueries(queryClient, organizationId),
  })
}
