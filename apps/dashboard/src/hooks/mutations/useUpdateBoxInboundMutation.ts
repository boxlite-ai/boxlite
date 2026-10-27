/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { queryKeys } from '@/hooks/queries/queryKeys'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { NetworkMode } from '@boxlite-ai/api-client'
import { useMutation, useQueryClient } from '@tanstack/react-query'

interface UpdateBoxInboundVariables {
  boxId: string
  mode: NetworkMode
}

/**
 * Enables or disables inbound access: whether the services a box exposes are
 * reachable through the proxy without signing in.
 *
 * Invalidating the box detail query is the point: `network` lives on the box
 * record, so the detail sheet has to re-read it before it can show the new
 * mode. Kept here with the other box mutations rather than inline in the
 * network section, so cache invalidation is defined once per resource.
 */
export const useUpdateBoxInboundMutation = () => {
  const api = useApi()
  const { selectedOrganization } = useSelectedOrganization()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ boxId, mode }: UpdateBoxInboundVariables) => {
      if (!selectedOrganization?.id) throw new Error('Missing organization')
      await api.setBoxInboundMode(selectedOrganization.id, boxId, mode)
    },
    onSuccess: (_, { boxId }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.boxes.detail(selectedOrganization?.id ?? '', boxId),
      })
    },
  })
}
