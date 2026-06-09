/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { isTransitioning } from '@/lib/utils/sandbox'
import { useQuery } from '@tanstack/react-query'
import { isAxiosError } from 'axios'
import { queryKeys } from './queryKeys'

export const useSandboxQuery = (sandboxId: string) => {
  const { sandboxApi } = useApi()
  const { selectedOrganization } = useSelectedOrganization()

  return useQuery({
    queryKey: queryKeys.sandboxes.detail(selectedOrganization?.id ?? '', sandboxId),
    queryFn: async () => {
      const response = await sandboxApi.getSandbox(sandboxId, selectedOrganization?.id)
      return response.data
    },
    enabled: !!sandboxId && !!selectedOrganization?.id,
    staleTime: 1000 * 10,
    refetchInterval: (query) => {
      const sandbox = query.state.data
      return sandbox && isTransitioning(sandbox) ? 3000 : false
    },
    retry: (failureCount, error) => {
      if (isAxiosError(error.cause) && error.cause?.status === 404) return false
      return failureCount < 3
    },
  })
}
