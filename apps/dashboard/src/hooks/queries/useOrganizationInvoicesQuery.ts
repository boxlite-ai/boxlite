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

/**
 * Converts an invoice type filter to a cache key string.
 * Serialise the filter the same way the request does, so it can key the cache.
 *
 * @param type - The invoice type filter ('all' or array of types)
 * @returns String representation for cache key
 */
function invoiceTypeKey(type: InvoiceTypeFilter): string {
  return typeof type === 'string' ? type : type.join(',')
}

/**
 * Fetches a paginated list of invoices for an organization.
 * Filters by invoice type and supports pagination.
 *
 * @param params - Query parameters
 * @param params.organizationId - The organization ID
 * @param params.type - Filter for invoice types ('all' or specific types)
 * @param params.page - Page number for pagination
 * @param params.perPage - Number of items per page
 * @param params.enabled - Whether the query should run
 * @returns React Query result with paginated invoices
 */
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
