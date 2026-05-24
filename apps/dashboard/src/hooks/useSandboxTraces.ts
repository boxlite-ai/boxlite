/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useQuery, UseQueryOptions } from '@tanstack/react-query'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { PaginatedTraces } from '@boxlite-ai/api-client'

export interface TracesQueryParams {
  from: Date
  to: Date
  page?: number
  limit?: number
}

export function useSandboxTraces(
  sandboxId: string | undefined,
  params: TracesQueryParams,
  options?: Omit<UseQueryOptions<PaginatedTraces>, 'queryKey' | 'queryFn'>,
) {
  const api = useApi()
  const { selectedOrganization } = useSelectedOrganization()

  return useQuery<PaginatedTraces>({
    queryKey: queryKeys.telemetry.traces(sandboxId ?? '', params),
    queryFn: async () => {
      if (!selectedOrganization || !sandboxId || !api.sandboxApi) {
        throw new Error('Missing required parameters')
      }
      const limit = params.limit ?? 50
      const page = params.page ?? 1

      const response = await api.sandboxApi.getSandboxTraces(
        sandboxId,
        params.from,
        params.to,
        selectedOrganization.id,
        page,
        limit,
      )

      return response.data
    },
    enabled: !!sandboxId && !!selectedOrganization && !!api.sandboxApi && !!params.from && !!params.to,
    staleTime: 10_000,
    ...options,
  })
}
