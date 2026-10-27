/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { catalogNameOf } from '@/lib/image-ref'
import { Box, BoxDesiredState } from '@boxlite-ai/api-client'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useApi } from '../useApi'
import { useSelectedOrganization } from '../useSelectedOrganization'

// The list API has no image filter, so one page of the organization's boxes
// is grouped here. Past this many, a group may be short; the count is then a
// floor, which the pages say.
export const BOXES_BY_IMAGE_PAGE = 200

/**
 * The organization's boxes that still reference each catalog image.
 *
 * Every box not destroyed counts, stopped ones included: those are the boxes
 * that block an image's removal, which is why a page wants them.
 */
export function useBoxesByImageQuery() {
  const { boxApi } = useApi()
  const { selectedOrganization } = useSelectedOrganization()

  const query = useQuery<Box[]>({
    queryKey: ['boxes', selectedOrganization?.id, 'by-image'],
    queryFn: async () => {
      if (!selectedOrganization) {
        throw new Error('No organization selected')
      }
      const response = await boxApi.listBoxesPaginated(selectedOrganization.id, 1, BOXES_BY_IMAGE_PAGE)
      return response.data.items
    },
    enabled: !!selectedOrganization,
  })

  const byImage = useMemo(() => {
    const groups = new Map<string, Box[]>()
    for (const box of query.data ?? []) {
      if (!box.image || box.desiredState === BoxDesiredState.DESTROYED) continue
      const name = catalogNameOf(box.image)
      groups.set(name, [...(groups.get(name) ?? []), box])
    }
    return groups
  }, [query.data])

  const byId = useMemo(() => new Map((query.data ?? []).map((box) => [box.id, box])), [query.data])

  return { ...query, byImage, byId, truncated: (query.data?.length ?? 0) >= BOXES_BY_IMAGE_PAGE }
}
