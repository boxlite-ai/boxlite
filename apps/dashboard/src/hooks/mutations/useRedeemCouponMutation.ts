/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { shouldRetryBillingMutation } from '@/billing-api/billingOperation'
import { queryKeys } from '../queries/queryKeys'
import { useApi } from '../useApi'

interface RedeemCouponVariables {
  organizationId: string
  couponCode: string
  idempotencyKey: string
}

export const useRedeemCouponMutation = () => {
  const { billingApi } = useApi()
  const queryClient = useQueryClient()

  return useMutation<string, unknown, RedeemCouponVariables>({
    mutationFn: ({ organizationId, couponCode, idempotencyKey }) =>
      billingApi.redeemCoupon(organizationId, couponCode, idempotencyKey),
    retry: shouldRetryBillingMutation,
    onSuccess: (_data, { organizationId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.organization.wallet(organizationId) })

      // a coupon can upgrade the tier
      queryClient.invalidateQueries({ queryKey: queryKeys.organization.tier(organizationId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.organization.usage.overview(organizationId) })
    },
  })
}
