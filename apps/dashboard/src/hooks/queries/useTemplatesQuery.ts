/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useQuery } from '@tanstack/react-query'
import type { BoxTemplateDto } from '@boxlite-ai/api-client'
import { useApi } from '../useApi'
import { useSelectedOrganization } from '../useSelectedOrganization'
import { queryKeys } from './queryKeys'

export type BoxTemplate = BoxTemplateDto

// Product-facing Dashboard copy calls these Images. The control plane still
// calls them BoxTemplates because each record carries defaults and artifactRef.
export function useTemplatesQuery() {
  const { axiosInstance } = useApi()
  const { selectedOrganization } = useSelectedOrganization()

  return useQuery<BoxTemplate[]>({
    queryKey: queryKeys.templates.list(selectedOrganization?.id ?? ''),
    queryFn: async () => {
      if (!selectedOrganization) {
        throw new Error('No organization selected')
      }

      const response = await axiosInstance.get<BoxTemplate[]>('/templates', {
        headers: {
          'X-BoxLite-Organization-ID': selectedOrganization.id,
        },
      })

      return response.data
    },
    enabled: !!selectedOrganization,
    staleTime: 1000 * 60,
    gcTime: 1000 * 60 * 5,
  })
}
