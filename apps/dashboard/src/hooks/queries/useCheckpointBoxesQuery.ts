/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Box, BoxState } from '@boxlite-ai/api-client'
import { useQuery } from '@tanstack/react-query'
import { useApi } from '../useApi'
import { getBoxesQueryKey } from '../useBoxes'
import { useSelectedOrganization } from '../useSelectedOrganization'

const SOURCE_BOX_POLL_INTERVAL = 30_000

export function useCheckpointBoxesQuery(enabled = true, polling = false, sourceIds?: readonly string[]) {
  const { boxApi } = useApi()
  const { selectedOrganization } = useSelectedOrganization()
  const sources = sourceIds === undefined ? undefined : [...new Set(sourceIds)].sort()
  return useQuery({
    queryKey: [...getBoxesQueryKey(selectedOrganization?.id), 'checkpoint-boxes', sources ?? 'eligible'],
    queryFn: async () => {
      if (!selectedOrganization) throw new Error('No organization selected')
      const boxes: Box[] = []
      for (const source of sources ?? [undefined]) {
        let page = 1
        let totalPages = 1
        do {
          const { data } = await boxApi.listBoxesPaginated(
            selectedOrganization.id,
            page,
            100,
            source,
            undefined,
            undefined,
            undefined,
            source === undefined ? [BoxState.STOPPED, BoxState.STARTED] : undefined,
          )
          // The ID filter also matches name prefixes; only the exact source
          // can label this checkpoint, including when that source is running.
          boxes.push(...data.items.filter((box) => source === undefined || box.id === source))
          totalPages = data.totalPages
        } while (++page <= totalPages)
      }
      return boxes
    },
    enabled: enabled && !!selectedOrganization,
    refetchInterval: (query) =>
      query.state.status !== 'error' &&
      (sources === undefined || polling || query.state.data?.some((box) => box.state !== box.desiredState))
        ? SOURCE_BOX_POLL_INTERVAL
        : false,
  })
}
