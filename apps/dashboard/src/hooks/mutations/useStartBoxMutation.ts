/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { useMutation, useQueryClient } from '@tanstack/react-query'

interface StartBoxVariables {
  boxId: string
  detailRef?: string
}

export const useStartBoxMutation = () => {
  const { boxApi } = useApi()
  const { selectedOrganization } = useSelectedOrganization()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ boxId }: StartBoxVariables) => {
      await boxApi.startBox(boxId, selectedOrganization?.id)
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
