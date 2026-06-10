/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { useMutation, useQueryClient } from '@tanstack/react-query'

interface DeleteBoxVariables {
  boxId: string
  detailRef?: string
}

export const useDeleteBoxMutation = () => {
  const { boxApi } = useApi()
  const { selectedOrganization } = useSelectedOrganization()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ boxId }: DeleteBoxVariables) => {
      await boxApi.deleteBox(boxId, selectedOrganization?.id)
    },
    onSuccess: (_, { boxId, detailRef }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.boxes.detail(selectedOrganization?.id ?? '', boxId),
      })
      if (detailRef && detailRef !== boxId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.boxes.detail(selectedOrganization?.id ?? '', detailRef),
        })
      }
    },
  })
}
