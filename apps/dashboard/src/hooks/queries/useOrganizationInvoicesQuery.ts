/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { InvoiceTypeFilter, PaginatedInvoices } from '@/billing-api/types/Invoice'
import { useQuery } from '@tanstack/react-query'
import { useApi } from '../useApi'
import { useConfig } from '../useConfig'
import { queryKeys } from './queryKeys'

/** Serialise the filter the same way the request does, so it can key the cache. */
function invoiceTypeKey(type: InvoiceTypeFilter): string {
  return typeof type === 'string' ? type : type.join(',')
}

export function useOrganizationInvoicesQuery({
  organizationId,
  type,
  page,
  perPage,
  enabled = true,
}: {
  organizationId: string
  type: InvoiceTypeFilter
  page?: number
  perPage?: number
  enabled?: boolean
}) {
  const { billingApi } = useApi()
  const config = useConfig()

  return useQuery<PaginatedInvoices>({
    // Two filters are two different listings, so the filter belongs in the key.
    queryKey: queryKeys.billing.invoices(organizationId, invoiceTypeKey(type), page, perPage),
    queryFn: () => billingApi.listInvoices(organizationId, page, perPage, type),
    enabled: Boolean(enabled && config.billingApiUrl && organizationId),
  })
}
