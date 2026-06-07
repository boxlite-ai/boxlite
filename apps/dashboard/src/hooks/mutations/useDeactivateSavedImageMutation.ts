/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../queries/queryKeys'
import { useApi } from '../useApi'

export interface DeactivateSavedImageMutationVariables {
  savedImageId: string
  organizationId?: string
}

interface UseDeactivateSavedImageMutationOptions {
  invalidateOnSuccess?: boolean
}

export const useDeactivateSavedImageMutation = ({
  invalidateOnSuccess = true,
}: UseDeactivateSavedImageMutationOptions = {}) => {
  const { savedImagesApi } = useApi()
  const queryClient = useQueryClient()

  return useMutation<void, unknown, DeactivateSavedImageMutationVariables>({
    mutationFn: async ({ savedImageId, organizationId }) => {
      if (!organizationId) {
        throw new Error('No organization selected')
      }
      await savedImagesApi.deactivateSavedImage(savedImageId, organizationId)
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
