/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { DEFAULT_SAVED_IMAGE_SORTING, SavedImageSorting } from '@/hooks/queries/useSavedImagesPageQuery'
import { ListSavedImagesOrderEnum, ListSavedImagesSortEnum } from '@boxlite-ai/api-client'
import { SortingState } from '@tanstack/react-table'

export const convertApiSortingToTableSorting = (sorting: SavedImageSorting): SortingState => {
  let id: string
  switch (sorting.field) {
    case ListSavedImagesSortEnum.NAME:
      id = 'name'
      break
    case ListSavedImagesSortEnum.STATE:
      id = 'state'
      break
    case ListSavedImagesSortEnum.CREATED_AT:
      id = 'createdAt'
      break
    case ListSavedImagesSortEnum.LAST_USED_AT:
    default:
      id = 'lastUsedAt'
      break
  }

  return [{ id, desc: sorting.direction === ListSavedImagesOrderEnum.DESC }]
}

export const convertTableSortingToApiSorting = (sorting: SortingState): SavedImageSorting => {
  if (!sorting.length) {
    return DEFAULT_SAVED_IMAGE_SORTING
  }

  const sort = sorting[0]
  let field: ListSavedImagesSortEnum

  switch (sort.id) {
    case 'name':
      field = ListSavedImagesSortEnum.NAME
      break
    case 'state':
      field = ListSavedImagesSortEnum.STATE
      break
    case 'createdAt':
      field = ListSavedImagesSortEnum.CREATED_AT
      break
    case 'lastUsedAt':
    default:
      field = ListSavedImagesSortEnum.LAST_USED_AT
      break
  }

  return {
    field,
    direction: sort.desc ? ListSavedImagesOrderEnum.DESC : ListSavedImagesOrderEnum.ASC,
  }
}
