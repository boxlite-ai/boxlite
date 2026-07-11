/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { BillingUsageSummary } from '@/billing-api'
import { useQuery } from '@tanstack/react-query'
import { useApi } from '../useApi'
import { queryKeys } from './queryKeys'

export function useBoxBillingUsageQuery(organizationId: string, boxId: string, enabled = true) {
  const { billingApi } = useApi()
  return useQuery<BillingUsageSummary>({
    queryKey: queryKeys.billing.boxUsage(organizationId, boxId),
    queryFn: () => billingApi.getBoxBillingUsage(organizationId, boxId),
    enabled: Boolean(enabled && organizationId && boxId),
    refetchOnWindowFocus: true,
  })
}
