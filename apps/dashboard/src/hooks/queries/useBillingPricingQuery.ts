/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { BillingPricing } from '@/billing-api'
import { useQuery } from '@tanstack/react-query'
import { useApi } from '../useApi'
import { queryKeys } from './queryKeys'

export function useBillingPricingQuery(organizationId: string, enabled = true) {
  const { billingApi } = useApi()
  return useQuery<BillingPricing>({
    queryKey: queryKeys.billing.pricing(organizationId),
    queryFn: () => billingApi.getBillingPricing(organizationId),
    enabled: Boolean(enabled && organizationId),
    staleTime: 60_000,
  })
}
