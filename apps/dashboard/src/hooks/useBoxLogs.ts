/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useQuery, UseQueryOptions } from '@tanstack/react-query'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { GetTenantLogsSeveritiesEnum, GetTenantLogsSourcesEnum, PaginatedLogs } from '@boxlite-ai/api-client'

export interface LogsQueryParams {
  from: Date
  to: Date
  page?: number
  limit?: number
  severities?: string[]
  sources?: string[]
  search?: string
  runnerId?: string
  jobId?: string
  traceId?: string
}

export function useBoxLogs(
  boxId: string | undefined,
  params: LogsQueryParams,
  options?: Omit<UseQueryOptions<PaginatedLogs>, 'queryKey' | 'queryFn'>,
) {
  const api = useApi()
  const { selectedOrganization } = useSelectedOrganization()

  return useQuery<PaginatedLogs>({
    queryKey: queryKeys.telemetry.logs(selectedOrganization?.id ?? '', boxId ?? '', params),
    queryFn: async () => {
      if (!selectedOrganization) {
        throw new Error('Missing required parameters')
      }
      const response = await api.observabilityApi.getTenantLogs(
        params.from,
        params.to,
        selectedOrganization.id,
        params.page ?? 1,
        params.limit ?? 50,
        params.sources as GetTenantLogsSourcesEnum[] | undefined,
        params.runnerId,
        boxId,
        params.jobId,
        params.search,
        params.severities as GetTenantLogsSeveritiesEnum[] | undefined,
        params.traceId,
        { timeout: 8_000 },
      )
      return response.data
    },
    enabled: !!selectedOrganization && !!params.from && !!params.to,
    staleTime: 10_000,
    ...options,
  })
}
