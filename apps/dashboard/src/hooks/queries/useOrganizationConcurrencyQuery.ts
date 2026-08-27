/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useApi } from '@/hooks/useApi'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { GetOrganizationUsageConcurrencyGranularityEnum, UsageConcurrencySeriesDto } from '@boxlite-ai/api-client'
import { useQuery } from '@tanstack/react-query'

export interface OrganizationConcurrencyQueryParams {
  organizationId: string
  from: Date
  to: Date
  granularity: GetOrganizationUsageConcurrencyGranularityEnum
  enabled?: boolean
}

export function useOrganizationConcurrencyQuery({
  organizationId,
  from,
  to,
  granularity,
  enabled = true,
}: OrganizationConcurrencyQueryParams) {
  const { usageApi } = useApi()
  const queryRange = { from: from.toISOString(), to: to.toISOString(), granularity }

  return useQuery<UsageConcurrencySeriesDto>({
    queryKey: queryKeys.organization.usage.concurrency(organizationId, queryRange),
    queryFn: async () => {
      const response = await usageApi.getOrganizationUsageConcurrency(organizationId, from, to, granularity)
      return response.data
    },
    enabled: Boolean(enabled && organizationId),
    staleTime: 60_000,
  })
}
