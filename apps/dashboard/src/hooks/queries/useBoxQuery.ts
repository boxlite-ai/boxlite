/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { isTransitioning } from '@/lib/utils/box'
import { useQuery } from '@tanstack/react-query'
import { isAxiosError } from 'axios'
import { queryKeys } from './queryKeys'

export const useBoxQuery = (boxId: string) => {
  const { boxApi } = useApi()
  const { selectedOrganization } = useSelectedOrganization()

  return useQuery({
    queryKey: queryKeys.boxes.detail(selectedOrganization?.id ?? '', boxId),
    queryFn: async () => {
      const response = await boxApi.getBox(boxId, selectedOrganization?.id)
      return response.data
    },
    enabled: !!boxId && !!selectedOrganization?.id,
    staleTime: 1000 * 10,
    refetchInterval: (query) => {
      const box = query.state.data
      return box && isTransitioning(box) ? 3000 : false
    },
    retry: (failureCount, error) => {
      if (isAxiosError(error.cause) && error.cause?.status === 404) return false
      return failureCount < 3
    },
  })
}
