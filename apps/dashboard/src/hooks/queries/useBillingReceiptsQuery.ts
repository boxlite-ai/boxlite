/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { BillingReceiptsPage } from '@/billing-api'
import { useQuery } from '@tanstack/react-query'
import { useApi } from '../useApi'
import { queryKeys } from './queryKeys'

export function useBillingReceiptsQuery({
  organizationId,
  page,
  pageSize,
  query,
  enabled = true,
}: {
  organizationId: string
  page: number
  pageSize: number
  query: string
  enabled?: boolean
}) {
  const { billingApi } = useApi()

  return useQuery<BillingReceiptsPage>({
    queryKey: queryKeys.billing.receipts(organizationId, page, pageSize, query),
    queryFn: () => billingApi.getBillingReceipts(organizationId, { page, pageSize, query }),
    enabled: Boolean(enabled && organizationId),
    refetchOnWindowFocus: true,
  })
}
