/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxTemplateDto } from '@boxlite-ai/api-client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../queries/queryKeys'
import { useApi } from '../useApi'

export interface ActivateTemplateMutationVariables {
  templateId: string
  organizationId?: string
}

interface UseActivateTemplateMutationOptions {
  invalidateOnSuccess?: boolean
}

export const useActivateTemplateMutation = ({
  invalidateOnSuccess = true,
}: UseActivateTemplateMutationOptions = {}) => {
  const { templatesApi } = useApi()
  const queryClient = useQueryClient()

  return useMutation<BoxTemplateDto, unknown, ActivateTemplateMutationVariables>({
    mutationFn: async ({ templateId, organizationId }) => {
      if (!organizationId) {
        throw new Error('No organization selected')
      }
      const response = await templatesApi.activateBoxTemplate(templateId, organizationId)
      return response.data
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
