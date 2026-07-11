/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { BillingPayment } from '@/billing-api'
import { useQuery } from '@tanstack/react-query'
import { useApi } from '../useApi'
import { queryKeys } from './queryKeys'

export function useBillingPaymentQuery(organizationId: string, enabled = true) {
  const { billingApi } = useApi()

  return useQuery<BillingPayment>({
    queryKey: queryKeys.billing.payment(organizationId),
    queryFn: () => billingApi.getBillingPayment(organizationId),
    enabled: Boolean(enabled && organizationId),
    refetchOnWindowFocus: true,
  })
}
