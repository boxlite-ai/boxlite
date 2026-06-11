/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useApi } from '@/hooks/useApi'
import { CreateBoxFromImageParams, CreateBoxFromTemplateParams, toCreateBoxRequest } from '@/lib/cloudBox'
import type { Box } from '@boxlite-ai/api-client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useSelectedOrganization } from '../useSelectedOrganization'
import { getBoxesQueryKey } from '../useBoxes'

export type CreateBoxParams = (CreateBoxFromTemplateParams | CreateBoxFromImageParams) & {
  target?: string
}

export const useCreateBoxMutation = () => {
  const { boxApi } = useApi()
  const { selectedOrganization } = useSelectedOrganization()
  const queryClient = useQueryClient()

  return useMutation<Box, unknown, CreateBoxParams>({
    mutationFn: async (params) => {
      if (!selectedOrganization?.id) throw new Error('Missing organization')
      const { target, ...createParams } = params
      return (await boxApi.createBox(toCreateBoxRequest(createParams, target), selectedOrganization.id)).data
    },
    onSuccess: async () => {
      if (selectedOrganization?.id) {
        await queryClient.invalidateQueries({ queryKey: getBoxesQueryKey(selectedOrganization.id) })
      }
    },
  })
}
