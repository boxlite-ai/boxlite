/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useApi } from '@/hooks/useApi'
import { stopBoxViaBoxApi } from '@/lib/cloudBox'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { useMutation, useQueryClient } from '@tanstack/react-query'

interface StopBoxVariables {
  boxId: string
  detailRef?: string
}

export const useStopBoxMutation = () => {
  const api = useApi()
  const { selectedOrganization } = useSelectedOrganization()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ boxId }: StopBoxVariables) => {
      if (!selectedOrganization?.id) throw new Error('Missing organization')
      await stopBoxViaBoxApi(api, selectedOrganization.id, boxId)
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
