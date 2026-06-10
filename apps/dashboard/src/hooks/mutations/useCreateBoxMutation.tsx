/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CreateBoxFromImageParams, CreateBoxFromSnapshotParams, BoxLite, Box } from '@boxlite-ai/sdk'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from 'react-oidc-context'
import { useSelectedOrganization } from '../useSelectedOrganization'
import { getBoxesQueryKey } from '../useBoxes'

export type CreateBoxParams = (CreateBoxFromSnapshotParams | CreateBoxFromImageParams) & {
  target?: string
}

export const useCreateBoxMutation = () => {
  const { user } = useAuth()
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
        apiUrl: import.meta.env.VITE_API_URL,
        organizationId: selectedOrganization.id,
        target,
      })

      if ('image' in createParams) {
        return await client.create(createParams as CreateBoxFromImageParams)
      }
      return await client.create(createParams as CreateBoxFromSnapshotParams)
    },
    onSuccess: async () => {
      if (selectedOrganization?.id) {
        await queryClient.invalidateQueries({ queryKey: getBoxesQueryKey(selectedOrganization.id) })
      }
    },
  })
}
