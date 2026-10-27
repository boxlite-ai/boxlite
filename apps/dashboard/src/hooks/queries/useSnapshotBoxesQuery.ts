/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Box, BoxState } from '@boxlite-ai/api-client'
import { useQuery } from '@tanstack/react-query'
import { SNAPSHOT_POLL_INTERVAL } from '@/lib/snapshots'
import { useApi } from '../useApi'
import { getBoxesQueryKey } from '../useBoxes'
import { useSelectedOrganization } from '../useSelectedOrganization'

export function useSnapshotBoxesQuery(enabled = true, polling = false) {
  const { boxApi } = useApi()
  const { selectedOrganization } = useSelectedOrganization()
  return useQuery({
    queryKey: [...getBoxesQueryKey(selectedOrganization?.id), 'snapshot-boxes'],
    queryFn: async () => {
      if (!selectedOrganization) throw new Error('No organization selected')
      const boxes: Box[] = []
      let page = 1
      let totalPages = 1
      do {
        const { data } = await boxApi.listBoxesPaginated(selectedOrganization.id, page, 100)
        boxes.push(...data.items)
        totalPages = data.totalPages
      } while (++page <= totalPages)
      return boxes
    },
    enabled: enabled && !!selectedOrganization,
    refetchInterval: (query) =>
      query.state.status !== 'error' &&
      (polling || query.state.data?.some((box) => box.state === BoxState.EXPORTING || box.state === BoxState.IMPORTING))
        ? SNAPSHOT_POLL_INTERVAL
        : false,
  })
}
