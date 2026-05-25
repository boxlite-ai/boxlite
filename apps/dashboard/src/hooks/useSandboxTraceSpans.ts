/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useQuery, UseQueryOptions } from '@tanstack/react-query'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { TelemetryScope } from '@/hooks/telemetryScope'
import { TraceSpan } from '@boxlite-ai/api-client'

export function useSandboxTraceSpans(
  sandboxId: string | undefined,
  traceId: string | undefined,
  options?: Omit<UseQueryOptions<TraceSpan[]>, 'queryKey' | 'queryFn'> & { scope?: TelemetryScope },
) {
  const api = useApi()
  const { selectedOrganization } = useSelectedOrganization()
  const { scope = 'sandbox', ...queryOptions } = options ?? {}
  const isAdminPlatform = scope === 'admin-platform'

  return useQuery<TraceSpan[]>({
    queryKey: isAdminPlatform
      ? queryKeys.telemetry.adminTraceSpans(traceId ?? '')
      : queryKeys.telemetry.traceSpans(sandboxId ?? '', traceId ?? ''),
    queryFn: async () => {
      if (isAdminPlatform) {
        if (!traceId) {
          throw new Error('Missing required parameters')
        }
        const response = await api.axiosInstance.get(`/admin/telemetry/traces/${encodeURIComponent(traceId)}`)
        return response.data
      }

      if (!selectedOrganization || !sandboxId || !traceId || !api.sandboxApi) {
        throw new Error('Missing required parameters')
      }
      const response = await api.sandboxApi.getSandboxTraceSpans(sandboxId, traceId, selectedOrganization.id)

      return response.data
    },
    enabled: isAdminPlatform
      ? !!traceId && !!api.axiosInstance
      : !!sandboxId && !!traceId && !!selectedOrganization && !!api.sandboxApi,
    staleTime: 30_000,
    ...queryOptions,
  })
}
