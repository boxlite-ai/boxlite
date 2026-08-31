/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { PaymentMethod } from '@/billing-api'
import { useQuery } from '@tanstack/react-query'
import { useApi } from '../useApi'
import { useConfig } from '../useConfig'
import { queryKeys } from './queryKeys'

export function useOrganizationPaymentMethodsQuery({
  organizationId,
  enabled = true,
}: {
  organizationId: string
  enabled?: boolean
}) {
  const { billingApi } = useApi()
  const config = useConfig()

  return useQuery<PaymentMethod[]>({
    queryKey: queryKeys.billing.paymentMethods(organizationId),
    queryFn: () => billingApi.listAllPaymentMethods(organizationId),
    enabled: Boolean(enabled && config.billingApiUrl && organizationId),
    refetchOnWindowFocus: true,
  })
}
