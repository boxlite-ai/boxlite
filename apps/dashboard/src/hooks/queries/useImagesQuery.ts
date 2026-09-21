/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Image, ImageDetail, ImageUsage } from '@boxlite-ai/api-client'
import { useQuery } from '@tanstack/react-query'
import { useApi } from '../useApi'
import { useSelectedOrganization } from '../useSelectedOrganization'
import { queryKeys } from './queryKeys'

/**
 * The organization's catalog, with the operator's curated set unioned in.
 *
 * Curated rows arrive with `id: null` and `curated: true`. They are not this
 * organization's to delete and do not count against its limit, which is why
 * usage is a separate call rather than a count of this list.
 */
export function useImagesQuery() {
  const { imageApi } = useApi()
  const { selectedOrganization } = useSelectedOrganization()

  return useQuery<Image[]>({
    queryKey: queryKeys.images.list(selectedOrganization?.id ?? ''),
    queryFn: async () => {
      if (!selectedOrganization) {
        throw new Error('No organization selected')
      }
      const response = await imageApi.listImages(selectedOrganization.id)
      return response.data
    },
    enabled: !!selectedOrganization,
  })
}

export function useImageQuery(idOrRef: string | undefined) {
  const { imageApi } = useApi()
  const { selectedOrganization } = useSelectedOrganization()

  return useQuery<ImageDetail>({
    queryKey: queryKeys.images.detail(selectedOrganization?.id ?? '', idOrRef ?? ''),
    queryFn: async () => {
      if (!selectedOrganization || !idOrRef) {
        throw new Error('No image selected')
      }
      const response = await imageApi.getImage(idOrRef, selectedOrganization.id)
      return response.data
    },
    enabled: !!selectedOrganization && !!idOrRef,
  })
}

export function useImageUsageQuery() {
  const { imageApi } = useApi()
  const { selectedOrganization } = useSelectedOrganization()

  return useQuery<ImageUsage>({
    queryKey: queryKeys.images.usage(selectedOrganization?.id ?? ''),
    queryFn: async () => {
      if (!selectedOrganization) {
        throw new Error('No organization selected')
      }
      const response = await imageApi.getImageUsage(selectedOrganization.id)
      return response.data
    },
    enabled: !!selectedOrganization,
  })
}
