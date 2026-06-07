/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useQuery } from '@tanstack/react-query'
import type { SavedImageDto } from '@boxlite-ai/api-client'
import { useApi } from '../useApi'
import { useSelectedOrganization } from '../useSelectedOrganization'
import { queryKeys } from './queryKeys'

export type SavedImage = SavedImageDto

// Product-facing Dashboard copy calls these Images. The control plane still
// calls them SavedImages because each record carries defaults and artifactRef.
export function useSavedImagesQuery() {
  const { axiosInstance } = useApi()
  const { selectedOrganization } = useSelectedOrganization()

  return useQuery<SavedImage[]>({
    queryKey: queryKeys.savedImages.list(selectedOrganization?.id ?? ''),
    queryFn: async () => {
      if (!selectedOrganization) {
        throw new Error('No organization selected')
      }

      const response = await axiosInstance.get<SavedImage[]>('/saved-images', {
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
