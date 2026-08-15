/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useQuery, UseQueryOptions } from '@tanstack/react-query'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { TraceSpan } from '@boxlite-ai/api-client'

export function useBoxTraceSpans(
  boxId: string | undefined,
  traceId: string | undefined,
  options?: Omit<UseQueryOptions<TraceSpan[]>, 'queryKey' | 'queryFn'>,
) {
  const api = useApi()
  const { selectedOrganization } = useSelectedOrganization()

  return useQuery<TraceSpan[]>({
    queryKey: queryKeys.telemetry.traceSpans(selectedOrganization?.id ?? '', boxId ?? '', traceId ?? ''),
    queryFn: async () => {
      if (!selectedOrganization || !traceId) {
        throw new Error('Missing required parameters')
      }
      const response = await api.axiosInstance.get<TraceSpan[]>(`/observability/traces/${traceId}`, {
        headers: { 'X-BoxLite-Organization-ID': selectedOrganization.id },
        params: { boxId },
        timeout: 8_000,
      })
      return response.data
    },
    enabled: !!traceId && !!selectedOrganization,
    staleTime: 30_000,
    ...options,
  })
}
