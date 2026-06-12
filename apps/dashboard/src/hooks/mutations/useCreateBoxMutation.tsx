/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CreateBoxFromImageParams, CreateBoxFromTemplateParams, BoxLite, Box } from '@boxlite-ai/sdk'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from 'react-oidc-context'
import { useConfig } from '../useConfig'
import { useSelectedOrganization } from '../useSelectedOrganization'
import { getBoxesQueryKey } from '../useBoxes'

export type CreateBoxParams = (CreateBoxFromTemplateParams | CreateBoxFromImageParams) & {
  target?: string
}

export const useCreateBoxMutation = () => {
  const { user } = useAuth()
  const { apiUrl } = useConfig()
  const { selectedOrganization } = useSelectedOrganization()
  const queryClient = useQueryClient()

  return useMutation<Box, unknown, CreateBoxParams>({
    mutationFn: async (params) => {
      if (!user?.access_token || !selectedOrganization?.id) {
        throw new Error('Missing authentication or organization')
      }

      const { target, ...createParams } = params
      const client = new BoxLite({
        jwtToken: user.access_token,
        apiUrl,
        organizationId: selectedOrganization.id,
        target,
      })

      if ('image' in createParams) {
        return await client.create(createParams as CreateBoxFromImageParams)
      }
      return await client.create(createParams as CreateBoxFromTemplateParams)
    },
    onSuccess: async () => {
      if (selectedOrganization?.id) {
        await queryClient.invalidateQueries({ queryKey: getBoxesQueryKey(selectedOrganization.id) })
      }
    },
  })
}
