/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { queryKeys } from '@/hooks/queries/queryKeys'
import type { PaginatedSavedImages } from '@/hooks/queries/useSavedImagesPageQuery'
import { useNotificationSocket } from '@/hooks/useNotificationSocket'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { SavedImageDto, SavedImageState } from '@boxlite-ai/api-client'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

export function useSavedImageWsSync() {
  const { notificationSocket } = useNotificationSocket()
  const { selectedOrganization } = useSelectedOrganization()
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!notificationSocket || !selectedOrganization?.id) return

    const savedImageListQueryKey = queryKeys.savedImages.list(selectedOrganization.id)
    const paginatedSavedImageListQueryKey = queryKeys.savedImages.paginatedList(selectedOrganization.id)

    const updateSavedImageInCacheIfPresent = (savedImage: SavedImageDto) => {
      queryClient.setQueryData<SavedImageDto[]>(savedImageListQueryKey, (previousSavedImages) => {
        if (!previousSavedImages) return previousSavedImages
        if (!previousSavedImages.some((existingSavedImage) => existingSavedImage.id === savedImage.id)) return previousSavedImages

        return previousSavedImages.map((existingSavedImage) =>
          existingSavedImage.id === savedImage.id ? savedImage : existingSavedImage,
        )
      })

      queryClient.setQueriesData<PaginatedSavedImages>(
        { queryKey: paginatedSavedImageListQueryKey },
        (previousSavedImages) => {
          if (!previousSavedImages) return previousSavedImages
          if (!previousSavedImages.items.some((existingSavedImage) => existingSavedImage.id === savedImage.id))
            return previousSavedImages

          return {
            ...previousSavedImages,
            items: previousSavedImages.items.map((existingSavedImage) =>
              existingSavedImage.id === savedImage.id ? savedImage : existingSavedImage,
            ),
          }
        },
      )
    }

    const invalidate = (refetchType: 'active' | 'none' = 'none') => {
      queryClient.invalidateQueries({
        queryKey: savedImageListQueryKey,
        refetchType,
      })
      queryClient.invalidateQueries({
        queryKey: paginatedSavedImageListQueryKey,
        refetchType,
      })
    }

    const handleSavedImageCreatedEvent = () => {
      invalidate('active')
    }

    const handleSavedImageStateUpdatedEvent = (data: {
      savedImage: SavedImageDto
      oldState: SavedImageState
      newState: SavedImageState
    }) => {
      updateSavedImageInCacheIfPresent(data.savedImage)
      invalidate()
    }

    const handleSavedImageRemovedEvent = () => {
      invalidate('active')
    }

    notificationSocket.on('savedImage.created', handleSavedImageCreatedEvent)
    notificationSocket.on('savedImage.state.updated', handleSavedImageStateUpdatedEvent)
    notificationSocket.on('savedImage.removed', handleSavedImageRemovedEvent)

    return () => {
      notificationSocket.off('savedImage.created', handleSavedImageCreatedEvent)
      notificationSocket.off('savedImage.state.updated', handleSavedImageStateUpdatedEvent)
      notificationSocket.off('savedImage.removed', handleSavedImageRemovedEvent)
    }
  }, [notificationSocket, queryClient, selectedOrganization?.id])
}
