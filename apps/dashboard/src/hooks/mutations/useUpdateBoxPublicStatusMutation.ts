/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { queryKeys } from '@/hooks/queries/queryKeys'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { useMutation, useQueryClient } from '@tanstack/react-query'

interface UpdateBoxPublicStatusVariables {
  boxId: string
  isPublic: boolean
}

/**
 * Flips whether a box's preview URLs are reachable without a credential.
 *
 * Invalidating the box detail query is the point: `public` lives on the box
 * record, so the detail sheet has to re-read it before it can show the new
 * value. Kept here with the other box mutations rather than inline in the
 * network section, so cache invalidation is defined once per resource.
 */
export const useUpdateBoxPublicStatusMutation = () => {
  const api = useApi()
  const { selectedOrganization } = useSelectedOrganization()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ boxId, isPublic }: UpdateBoxPublicStatusVariables) => {
      if (!selectedOrganization?.id) throw new Error('Missing organization')
      await api.boxApi.updatePublicStatus(boxId, isPublic, selectedOrganization.id)
    },
    onSuccess: (_, { boxId }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.boxes.detail(selectedOrganization?.id ?? '', boxId),
      })
    },
  })
}
