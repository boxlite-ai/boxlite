/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { SupportedBoxImage } from '@boxlite-ai/api-client'
import { useQuery } from '@tanstack/react-query'
import { useApi } from '../useApi'
import { useSelectedOrganization } from '../useSelectedOrganization'
import { queryKeys } from './queryKeys'

export function useSupportedBoxImagesQuery() {
  const api = useApi()
  const { selectedOrganization } = useSelectedOrganization()

  return useQuery<SupportedBoxImage[]>({
    queryKey: queryKeys.box.supportedImages(selectedOrganization?.id ?? ''),
    queryFn: async () => {
      if (!selectedOrganization?.id) {
        throw new Error('No organization selected')
      }

      const response = await api.boxApi.listSupportedBoxImages(selectedOrganization.id)
      return response.data
    },
    enabled: !!selectedOrganization?.id,
  })
}
