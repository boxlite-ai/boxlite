/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CreateSavedImage, SavedImageDto } from '@boxlite-ai/api-client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../queries/queryKeys'
import { useApi } from '../useApi'

export interface CreateSavedImageMutationVariables {
  savedImage: CreateSavedImage
  organizationId?: string
}

export const useCreateSavedImageMutation = () => {
  const { savedImagesApi } = useApi()
  const queryClient = useQueryClient()

  return useMutation<SavedImageDto, unknown, CreateSavedImageMutationVariables>({
    mutationFn: async ({ savedImage, organizationId }) => {
      const response = await savedImagesApi.createSavedImage(savedImage, organizationId)
      return response.data
    },
    onSuccess: async (_data, { organizationId }) => {
      if (organizationId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.savedImages.all })
      }
    },
  })
}
