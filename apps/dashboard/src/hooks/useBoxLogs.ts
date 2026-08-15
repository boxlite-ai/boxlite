/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useQuery, UseQueryOptions } from '@tanstack/react-query'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { PaginatedLogs } from '@boxlite-ai/api-client'

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
      const response = await api.axiosInstance.get<PaginatedLogs>('/observability/logs', {
        headers: { 'X-BoxLite-Organization-ID': selectedOrganization.id },
        params: {
          from: params.from.toISOString(),
          to: params.to.toISOString(),
          page: params.page ?? 1,
          limit: params.limit ?? 50,
          severities: params.severities?.join(','),
          sources: params.sources?.join(','),
          search: params.search,
          runnerId: params.runnerId,
          boxId,
          jobId: params.jobId,
          traceId: params.traceId,
        },
        timeout: 8_000,
      })
      return response.data
    },
    enabled: !!selectedOrganization && !!params.from && !!params.to,
    staleTime: 10_000,
    ...options,
  })
}
