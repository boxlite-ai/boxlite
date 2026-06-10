/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { useMutation } from '@tanstack/react-query'

interface RevokeSshAccessVariables {
  boxId: string
  token: string
}

export const useRevokeSshAccessMutation = () => {
  const { boxApi } = useApi()
  const { selectedOrganization } = useSelectedOrganization()

  return useMutation({
    mutationFn: async ({ boxId, token }: RevokeSshAccessVariables) => {
      await boxApi.revokeSshAccess(boxId, selectedOrganization?.id, token)
    },
  })
}
