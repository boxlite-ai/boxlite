/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useQuery, UseQueryOptions } from '@tanstack/react-query'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { buildTelemetrySearchParams, TelemetryScope } from '@/hooks/telemetryScope'
import { MetricsResponse } from '@boxlite-ai/api-client'

export interface MetricsQueryParams {
  from: Date
  to: Date
  metricNames?: string[]
}

export function useSandboxMetrics(
  sandboxId: string | undefined,
  params: MetricsQueryParams,
  options?: Omit<UseQueryOptions<MetricsResponse>, 'queryKey' | 'queryFn'> & { scope?: TelemetryScope },
) {
  const api = useApi()
  const { selectedOrganization } = useSelectedOrganization()
  const { scope = 'sandbox', ...queryOptions } = options ?? {}
  const isAdminPlatform = scope === 'admin-platform'

  return useQuery<MetricsResponse>({
    queryKey: isAdminPlatform
      ? queryKeys.telemetry.adminMetrics(params)
      : queryKeys.telemetry.metrics(sandboxId ?? '', params),
    queryFn: async () => {
      if (isAdminPlatform) {
        const response = await api.axiosInstance.get('/admin/telemetry/metrics', {
          params: buildTelemetrySearchParams(params),
        })
        return response.data
      }

      if (!selectedOrganization || !sandboxId || !api.sandboxApi) {
        throw new Error('Missing required parameters')
      }

      const response = await api.sandboxApi.getSandboxMetrics(
        sandboxId,
        params.from,
        params.to,
        selectedOrganization.id,
        params.metricNames,
      )

      return response.data
    },
    enabled: isAdminPlatform
      ? !!api.axiosInstance && !!params.from && !!params.to
      : !!sandboxId && !!selectedOrganization && !!api.sandboxApi && !!params.from && !!params.to,
    staleTime: 10_000,
    ...queryOptions,
  })
}
