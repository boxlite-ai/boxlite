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
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.images.list(organizationId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.images.usage(organizationId) }),
      ])
    },
  })
}
