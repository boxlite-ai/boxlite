/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { useMutation, useQueryClient } from '@tanstack/react-query'

interface RevokeSshAccessVariables {
  boxId: string
  credentialId: string
}

export const useRevokeSshAccessMutation = () => {
  const { sshAccessApi } = useApi()
  const { selectedOrganization } = useSelectedOrganization()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ boxId, credentialId }: RevokeSshAccessVariables) => {
      await sshAccessApi.revokeTemporarySshCredential(boxId, credentialId, selectedOrganization?.id)
    },
    onSuccess: (_data, { boxId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sshCredentials.list(boxId) })
    },
  })
}
