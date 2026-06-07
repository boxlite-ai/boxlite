/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { DEFAULT_TEMPLATE_SORTING, TemplateSorting } from '@/hooks/queries/useTemplatesPageQuery'
import { ListBoxTemplatesOrderEnum, ListBoxTemplatesSortEnum } from '@boxlite-ai/api-client'
import { SortingState } from '@tanstack/react-table'

export const convertApiSortingToTableSorting = (sorting: TemplateSorting): SortingState => {
  let id: string
  switch (sorting.field) {
    case ListBoxTemplatesSortEnum.NAME:
      id = 'name'
      break
    case ListBoxTemplatesSortEnum.STATE:
      id = 'state'
      break
    case ListBoxTemplatesSortEnum.CREATED_AT:
      id = 'createdAt'
      break
    case ListBoxTemplatesSortEnum.LAST_USED_AT:
    default:
      id = 'lastUsedAt'
      break
  }

  return [{ id, desc: sorting.direction === ListBoxTemplatesOrderEnum.DESC }]
}

export const convertTableSortingToApiSorting = (sorting: SortingState): TemplateSorting => {
  if (!sorting.length) {
    return DEFAULT_TEMPLATE_SORTING
  }

  const sort = sorting[0]
  let field: ListBoxTemplatesSortEnum

  switch (sort.id) {
    case 'name':
      field = ListBoxTemplatesSortEnum.NAME
      break
    case 'state':
      field = ListBoxTemplatesSortEnum.STATE
      break
    case 'createdAt':
      field = ListBoxTemplatesSortEnum.CREATED_AT
      break
    case 'lastUsedAt':
    default:
      field = ListBoxTemplatesSortEnum.LAST_USED_AT
      break
  }

  return {
    field,
    direction: sort.desc ? ListBoxTemplatesOrderEnum.DESC : ListBoxTemplatesOrderEnum.ASC,
  }
}
