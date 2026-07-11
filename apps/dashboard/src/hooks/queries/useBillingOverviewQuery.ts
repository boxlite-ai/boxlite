/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { BillingOverview } from '@/billing-api'
import { useQuery } from '@tanstack/react-query'
import { useApi } from '../useApi'
import { queryKeys } from './queryKeys'

export function useBillingOverviewQuery({
  organizationId,
  from,
  to,
  enabled = true,
}: {
  organizationId: string
  from: Date
  to: Date
  enabled?: boolean
}) {
  const { billingApi } = useApi()
  return useQuery<BillingOverview>({
    queryKey: queryKeys.billing.overview(organizationId, from.toISOString(), to.toISOString()),
    queryFn: () => billingApi.getBillingOverview(organizationId, from, to),
    enabled: Boolean(enabled && organizationId),
    refetchOnWindowFocus: true,
  })
}
