/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../queries/queryKeys'
import { useApi } from '../useApi'

export interface DeactivateTemplateMutationVariables {
  templateId: string
  organizationId?: string
}

interface UseDeactivateTemplateMutationOptions {
  invalidateOnSuccess?: boolean
}

export const useDeactivateTemplateMutation = ({
  invalidateOnSuccess = true,
}: UseDeactivateTemplateMutationOptions = {}) => {
  const { templatesApi } = useApi()
  const queryClient = useQueryClient()

  return useMutation<void, unknown, DeactivateTemplateMutationVariables>({
    mutationFn: async ({ templateId, organizationId }) => {
      if (!organizationId) {
        throw new Error('No organization selected')
      }
      await templatesApi.deactivateBoxTemplate(templateId, organizationId)
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
