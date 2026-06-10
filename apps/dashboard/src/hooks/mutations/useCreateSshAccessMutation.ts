/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { useMutation } from '@tanstack/react-query'

interface CreateSshAccessVariables {
  boxId: string
  expiresInMinutes: number
}

export const useCreateSshAccessMutation = () => {
  const { boxApi } = useApi()
  const { selectedOrganization } = useSelectedOrganization()

  return useMutation({
    mutationFn: async ({ boxId, expiresInMinutes }: CreateSshAccessVariables) => {
      const response = await boxApi.createSshAccess(boxId, selectedOrganization?.id, expiresInMinutes)
      return response.data
    },
  })
}
