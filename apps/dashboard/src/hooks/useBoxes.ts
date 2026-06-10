/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { QueryKey, useQuery } from '@tanstack/react-query'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { isTransitioning } from '@/lib/utils/box'
import {
  ListBoxesPaginatedOrderEnum,
  ListBoxesPaginatedSortEnum,
  ListBoxesPaginatedStatesEnum,
  PaginatedBoxes,
} from '@boxlite-ai/api-client'
import { isValidUUID } from '@/lib/utils'

export interface BoxFilters {
  idOrName?: string
  labels?: Record<string, string>
  includeErroredDeleted?: boolean
  states?: ListBoxesPaginatedStatesEnum[]
  templates?: string[]
  regions?: string[]
  minCpu?: number
  maxCpu?: number
  minMemoryGiB?: number
  maxMemoryGiB?: number
  minDiskGiB?: number
  maxDiskGiB?: number
  lastEventAfter?: Date
  lastEventBefore?: Date
}

export interface BoxSorting {
  field?: ListBoxesPaginatedSortEnum
  direction?: ListBoxesPaginatedOrderEnum
}

export const DEFAULT_BOX_SORTING: BoxSorting = {
  field: ListBoxesPaginatedSortEnum.UPDATED_AT,
  direction: ListBoxesPaginatedOrderEnum.DESC,
}

export interface BoxQueryParams {
  page: number
  pageSize: number
  filters?: BoxFilters
  sorting?: BoxSorting
}

export const getBoxesQueryKey = (organizationId: string | undefined, params?: BoxQueryParams): QueryKey => {
  const baseKey = ['boxes' as const, organizationId]

  if (!params) {
    return baseKey
  }

  const normalizedParams = {
    page: params.page,
    pageSize: params.pageSize,
    ...(params.filters && { filters: params.filters }),
    ...(params.sorting && { sorting: params.sorting }),
  }

  return [...baseKey, normalizedParams]
}

export function useBoxes(queryKey: QueryKey, params: BoxQueryParams) {
  const { boxApi } = useApi()
  const { selectedOrganization } = useSelectedOrganization()

  return useQuery<PaginatedBoxes>({
    queryKey,
    queryFn: async () => {
      if (!selectedOrganization) {
        throw new Error('No organization selected')
      }

      const { page, pageSize, filters = {}, sorting = {} } = params

      const listResponse = await boxApi.listBoxesPaginated(
        selectedOrganization.id,
        page,
        pageSize,
        undefined,
        filters.idOrName,
        filters.labels ? JSON.stringify(filters.labels) : undefined,
        filters.includeErroredDeleted,
        filters.states,
        filters.templates,
        filters.regions,
        filters.minCpu,
        filters.maxCpu,
        filters.minMemoryGiB,
        filters.maxMemoryGiB,
        filters.minDiskGiB,
        filters.maxDiskGiB,
        filters.lastEventAfter,
        filters.lastEventBefore,
        sorting.field,
        sorting.direction,
      )

      let paginatedData = listResponse.data

      // TODO: this will be obsolete once we introduce the search API
      if (filters.idOrName && isValidUUID(filters.idOrName) && page === 1) {
        // Attempt to fetch box by ID if the search value is a valid UUID
        try {
          const box = (await boxApi.getBox(filters.idOrName, selectedOrganization.id)).data
          const existsInPaginatedData = paginatedData.items.some((item) => item.id === box.id)

          if (!existsInPaginatedData) {
            paginatedData = {
              ...paginatedData,
              // This is an exact UUID match, ignore sorting
              items: [box, ...paginatedData.items],
              total: paginatedData.total + 1,
            }
          }
        } catch (error) {
          // TODO: rethrow if not 4xx
        }
      }

      return paginatedData
    },
    enabled: !!selectedOrganization,
    staleTime: 1000 * 10, // 10 seconds
    refetchInterval: (query) => {
      const boxes = query.state.data?.items
      return boxes?.some(isTransitioning) ? 3000 : false
    },
    gcTime: 1000 * 60 * 5, // 5 minutes,
  })
}
