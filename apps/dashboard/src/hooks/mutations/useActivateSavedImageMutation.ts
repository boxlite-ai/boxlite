/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { SavedImageDto } from '@boxlite-ai/api-client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../queries/queryKeys'
import { useApi } from '../useApi'

export interface ActivateSavedImageMutationVariables {
  savedImageId: string
  organizationId?: string
}

interface UseActivateSavedImageMutationOptions {
  invalidateOnSuccess?: boolean
}

export const useActivateSavedImageMutation = ({
  invalidateOnSuccess = true,
}: UseActivateSavedImageMutationOptions = {}) => {
  const { savedImagesApi } = useApi()
  const queryClient = useQueryClient()

  return useMutation<SavedImageDto, unknown, ActivateSavedImageMutationVariables>({
    mutationFn: async ({ savedImageId, organizationId }) => {
      if (!organizationId) {
        throw new Error('No organization selected')
      }
      const response = await savedImagesApi.activateSavedImage(savedImageId, organizationId)
      return response.data
    },
    onSuccess: async (_data, { organizationId }) => {
      if (invalidateOnSuccess && organizationId) {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.savedImages.all,
        })
      }
    },
  })
}
