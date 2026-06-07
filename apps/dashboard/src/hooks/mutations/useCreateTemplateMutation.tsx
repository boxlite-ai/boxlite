/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CreateBoxTemplate, BoxTemplateDto } from '@boxlite-ai/api-client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../queries/queryKeys'
import { useApi } from '../useApi'

export interface CreateTemplateMutationVariables {
  template: CreateBoxTemplate
  organizationId?: string
}

export const useCreateTemplateMutation = () => {
  const { templatesApi } = useApi()
  const queryClient = useQueryClient()

  return useMutation<BoxTemplateDto, unknown, CreateTemplateMutationVariables>({
    mutationFn: async ({ template, organizationId }) => {
      const response = await templatesApi.createBoxTemplate(template, organizationId)
      return response.data
    },
    onSuccess: async (_data, { organizationId }) => {
      if (organizationId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.templates.all })
      }
    },
  })
}
