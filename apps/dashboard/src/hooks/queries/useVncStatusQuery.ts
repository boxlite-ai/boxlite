/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { useQuery } from '@tanstack/react-query'
import { queryKeys } from './queryKeys'

const parseVncStatus = (data: { status?: unknown }) => {
  if (typeof data.status !== 'string' || data.status.length === 0) {
    throw new Error('Unexpected VNC status response')
  }

  return data.status
}

export const useVncInitialStatusQuery = (boxId: string, enabled: boolean) => {
  const { toolboxApi } = useApi()
  const { selectedOrganization } = useSelectedOrganization()

  return useQuery({
    queryKey: queryKeys.boxes.vncInitialStatus(boxId),
    queryFn: async () => {
      const { data } = await toolboxApi.getComputerUseStatusDeprecated(boxId, selectedOrganization?.id)
      return parseVncStatus(data)
    },
    enabled: enabled && !!boxId && !!selectedOrganization?.id,
    retry: false,
    staleTime: 0,
  })
}

export const useVncPollStatusQuery = (boxId: string, enabled: boolean) => {
  const { toolboxApi } = useApi()
  const { selectedOrganization } = useSelectedOrganization()

  return useQuery({
    queryKey: queryKeys.boxes.vncPollStatus(boxId),
    queryFn: async () => {
      const { data } = await toolboxApi.getComputerUseStatusDeprecated(boxId, selectedOrganization?.id)
      const status = parseVncStatus(data)
      if (status !== 'active') throw new Error(`VNC not ready: ${status}`)
      return status
    },
    enabled: enabled && !!boxId && !!selectedOrganization?.id,
    retry: 30,
    retryDelay: 2000,
  })
}
