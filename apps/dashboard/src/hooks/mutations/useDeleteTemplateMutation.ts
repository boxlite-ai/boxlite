/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../queries/queryKeys'
import { useApi } from '../useApi'

export interface DeleteTemplateMutationVariables {
  templateId: string
  organizationId?: string
}

interface UseDeleteTemplateMutationOptions {
  invalidateOnSuccess?: boolean
}

export const useDeleteTemplateMutation = ({ invalidateOnSuccess = true }: UseDeleteTemplateMutationOptions = {}) => {
  const { templatesApi } = useApi()
  const queryClient = useQueryClient()

  return useMutation<void, unknown, DeleteTemplateMutationVariables>({
    mutationFn: async ({ templateId, organizationId }) => {
      if (!organizationId) {
        throw new Error('No organization selected')
      }
      await templatesApi.removeBoxTemplate(templateId, organizationId)
    },
    onSuccess: async (_data, { organizationId }) => {
      if (invalidateOnSuccess && organizationId) {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.templates.all,
        })
      }
    },
  })
}
