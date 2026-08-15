/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useQuery, UseQueryOptions } from '@tanstack/react-query'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { MetricsResponse } from '@boxlite-ai/api-client'

export interface MetricsQueryParams {
  from: Date
  to: Date
  metricNames?: string[]
}

export function useBoxMetrics(
  boxId: string | undefined,
  params: MetricsQueryParams,
  options?: Omit<UseQueryOptions<MetricsResponse>, 'queryKey' | 'queryFn'>,
) {
  const api = useApi()
  const { selectedOrganization } = useSelectedOrganization()

  return useQuery<MetricsResponse>({
    queryKey: queryKeys.telemetry.metrics(selectedOrganization?.id ?? '', boxId ?? '', params),
    queryFn: async () => {
      if (!selectedOrganization || !boxId) {
        throw new Error('Missing required parameters')
      }
      const response = await api.axiosInstance.get<MetricsResponse>('/observability/metrics', {
        headers: { 'X-BoxLite-Organization-ID': selectedOrganization.id },
        params: {
          from: params.from.toISOString(),
          to: params.to.toISOString(),
          boxId,
          metricNames: params.metricNames?.join(','),
        },
        timeout: 8_000,
      })
      return response.data
    },
    enabled: !!boxId && !!selectedOrganization && !!params.from && !!params.to,
    staleTime: 10_000,
    ...options,
  })
}
