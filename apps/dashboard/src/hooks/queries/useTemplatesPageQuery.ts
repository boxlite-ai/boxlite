/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxTemplateDto, ListBoxTemplatesOrderEnum, ListBoxTemplatesSortEnum } from '@boxlite-ai/api-client'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useApi } from '../useApi'
import { useSelectedOrganization } from '../useSelectedOrganization'
import { queryKeys } from './queryKeys'

export interface TemplateFilters {
  name?: string
}

export interface TemplateSorting {
  field: ListBoxTemplatesSortEnum
  direction: ListBoxTemplatesOrderEnum
}

export const DEFAULT_TEMPLATE_SORTING: TemplateSorting = {
  field: ListBoxTemplatesSortEnum.LAST_USED_AT,
  direction: ListBoxTemplatesOrderEnum.DESC,
}

export interface TemplateQueryParams {
  page: number
  pageSize: number
  filters?: TemplateFilters
  sorting?: TemplateSorting
}

export interface PaginatedBoxTemplates {
  items: BoxTemplateDto[]
  total: number
  page: number
  totalPages: number
}

// The user-facing page is Images, but the API contract remains templates so
// runtime artifact semantics stay separate from presentation language.
export function useTemplatesPageQuery(params: TemplateQueryParams) {
  const { templatesApi } = useApi()
  const { selectedOrganization } = useSelectedOrganization()

  return useQuery<PaginatedBoxTemplates>({
    queryKey: queryKeys.templates.paginatedList(selectedOrganization?.id ?? '', params),
    queryFn: async () => {
      if (!selectedOrganization) {
        throw new Error('No organization selected')
      }

      const { page, pageSize, filters = {}, sorting = DEFAULT_TEMPLATE_SORTING } = params

      const response = await templatesApi.listBoxTemplates(
        selectedOrganization.id,
        page,
        pageSize,
        filters.name,
        sorting.field,
        sorting.direction,
      )

      return response.data as unknown as PaginatedBoxTemplates
    },
    enabled: !!selectedOrganization,
    placeholderData: keepPreviousData,
    staleTime: 1000 * 10,
    gcTime: 1000 * 60 * 5,
  })
}
