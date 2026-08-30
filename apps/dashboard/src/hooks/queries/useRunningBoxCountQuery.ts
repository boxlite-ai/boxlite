/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ListBoxesPaginatedStatesEnum } from '@boxlite-ai/api-client'
import { useQuery, UseQueryOptions } from '@tanstack/react-query'
import { useApi } from '../useApi'
import { queryKeys } from './queryKeys'

/**
 * How many boxes are running right now — the count a concurrency ceiling is
 * spent against.
 *
 * `started` alone, because that is the state the box table itself labels
 * "Running": a box that is `starting` has not taken its slot yet and one that
 * is `stopping` is giving it back, so counting either would report a ceiling
 * reached that the customer has not reached.
 *
 * Read from the LIST endpoint's own `total` with `limit: 1`, so the answer
 * costs one row rather than a page of boxes nobody renders. It is a
 * point-in-time number and nothing more. The usage concurrency endpoint owns
 * historical sampling; this lightweight count keeps summary cards independent
 * from a 30-day series query.
 */
export const useRunningBoxCountQuery = ({
  organizationId,
  enabled = true,
  ...queryOptions
}: {
  organizationId: string | undefined
  enabled?: boolean
} & Omit<UseQueryOptions<number>, 'queryKey' | 'queryFn'>) => {
  const { boxApi } = useApi()

  return useQuery<number>({
    queryKey: queryKeys.boxes.runningCount(organizationId ?? ''),
    queryFn: async () => {
      const response = await boxApi.listBoxesPaginated(
        organizationId,
        1,
        1,
        undefined,
        undefined,
        undefined,
        undefined,
        [ListBoxesPaginatedStatesEnum.STARTED],
      )
      return response.data.total
    },
    enabled: Boolean(enabled && organizationId),
    refetchOnWindowFocus: true,
    ...queryOptions,
  })
}
