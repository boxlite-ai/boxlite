/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  ListSavedImagesOrderEnum,
  ListSavedImagesSortEnum,
  PaginatedSavedImages as ApiPaginatedSavedImages,
} from '@boxlite-ai/api-client'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useApi } from '../useApi'
import { useSelectedOrganization } from '../useSelectedOrganization'
import { queryKeys } from './queryKeys'

export interface SavedImageFilters {
  name?: string
}

export interface SavedImageSorting {
  field: ListSavedImagesSortEnum
  direction: ListSavedImagesOrderEnum
}

export const DEFAULT_SAVED_IMAGE_SORTING: SavedImageSorting = {
  field: ListSavedImagesSortEnum.LAST_USED_AT,
  direction: ListSavedImagesOrderEnum.DESC,
}

export interface SavedImageQueryParams {
  page: number
  pageSize: number
  filters?: SavedImageFilters
  sorting?: SavedImageSorting
}

export type PaginatedSavedImages = ApiPaginatedSavedImages

// The user-facing page is Images, but the API contract remains savedImages so
// runtime artifact semantics stay separate from presentation language.
export function useSavedImagesPageQuery(params: SavedImageQueryParams) {
  const { savedImagesApi } = useApi()
  const { selectedOrganization } = useSelectedOrganization()

  return useQuery<PaginatedSavedImages>({
    queryKey: queryKeys.savedImages.paginatedList(selectedOrganization?.id ?? '', params),
    queryFn: async () => {
      if (!selectedOrganization) {
        throw new Error('No organization selected')
      }

      const { page, pageSize, filters = {}, sorting = DEFAULT_SAVED_IMAGE_SORTING } = params

      const response = await savedImagesApi.listSavedImages(
        selectedOrganization.id,
        page,
        pageSize,
        filters.name,
        sorting.field,
        sorting.direction,
      )

      if (Array.isArray(response.data)) {
        return {
          items: response.data,
          total: response.data.length,
          page,
          totalPages: 1,
        }
      }

      return response.data
    },
    enabled: !!selectedOrganization,
    placeholderData: keepPreviousData,
    staleTime: 1000 * 10,
    gcTime: 1000 * 60 * 5,
  })
}
