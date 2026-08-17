/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useQuery, UseQueryOptions } from '@tanstack/react-query'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { GetTenantTracesSourcesEnum, PaginatedTraces } from '@boxlite-ai/api-client'

export interface TracesQueryParams {
  from: Date
  to: Date
  page?: number
  limit?: number
  sources?: string[]
  runnerId?: string
  jobId?: string
}

export function useBoxTraces(
  boxId: string | undefined,
  params: TracesQueryParams,
  options?: Omit<UseQueryOptions<PaginatedTraces>, 'queryKey' | 'queryFn'>,
) {
  const api = useApi()
  const { selectedOrganization } = useSelectedOrganization()

  return useQuery<PaginatedTraces>({
    queryKey: queryKeys.telemetry.traces(selectedOrganization?.id ?? '', boxId ?? '', params),
    queryFn: async () => {
      if (!selectedOrganization) {
        throw new Error('Missing required parameters')
      }
      const response = await api.observabilityApi.getTenantTraces(
        params.from,
        params.to,
        selectedOrganization.id,
        params.page ?? 1,
        params.limit ?? 50,
        params.sources as GetTenantTracesSourcesEnum[] | undefined,
        params.runnerId,
        boxId,
        params.jobId,
        { timeout: 8_000 },
      )
      return response.data
    },
    enabled: !!selectedOrganization && !!params.from && !!params.to,
    staleTime: 10_000,
    ...options,
  })
}
