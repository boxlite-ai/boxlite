/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../queries/queryKeys'
import { useApi } from '../useApi'

export interface DeleteImageMutationVariables {
  idOrRef: string
  organizationId?: string
}

/**
 * Removes an image from the catalog.
 *
 * Usage is invalidated alongside the list because the two are separate reads
 * of the same fact: a delete that left the count standing would show a bar
 * that disagrees with the rows under it.
 *
 * Cached details are removed rather than invalidated: the deleted image's
 * refetch can only 404, and a failed refetch keeps the old data, so reopening
 * the page would go on showing the record that was just deleted. Every detail
 * of the organization goes, because the page may have cached this image under
 * its reference while the list removes it by id; the others are read again
 * when next opened.
 */
export const useDeleteImageMutation = () => {
  const { imageApi } = useApi()
  const queryClient = useQueryClient()

  return useMutation<void, unknown, DeleteImageMutationVariables>({
    mutationFn: async ({ idOrRef, organizationId }) => {
      if (!organizationId) {
        throw new Error('No organization selected')
      }
      await imageApi.deleteImage(idOrRef, organizationId)
    },
    onSuccess: async (_data, { organizationId }) => {
      if (!organizationId) {
        return
      }
      queryClient.removeQueries({ queryKey: queryKeys.images.details(organizationId) })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.images.list(organizationId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.images.usage(organizationId) }),
      ])
    },
  })
}
