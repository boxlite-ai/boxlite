/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { TemporarySshCredential } from '@boxlite-ai/api-client'
import { useQuery } from '@tanstack/react-query'
import { useApi } from '../useApi'
import { useSelectedOrganization } from '../useSelectedOrganization'
import { queryKeys } from './queryKeys'

export const useSshCredentialsQuery = (boxId: string, enabled = true) => {
  const { sshAccessApi } = useApi()
  const { selectedOrganization } = useSelectedOrganization()

  return useQuery<TemporarySshCredential[]>({
    queryKey: queryKeys.sshCredentials.list(boxId),
    enabled: enabled && Boolean(boxId),
    queryFn: async () => {
      const response = await sshAccessApi.listTemporarySshCredentials(boxId, selectedOrganization?.id)
      return response.data
    },
  })
}
