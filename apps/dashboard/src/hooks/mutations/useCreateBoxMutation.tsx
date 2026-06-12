/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useApi } from '@/hooks/useApi'
import { CreateBoxParams, createBoxViaBoxApi } from '@/lib/cloudBox'
import type { Box } from '@boxlite-ai/api-client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useSelectedOrganization } from '../useSelectedOrganization'
import { getBoxesQueryKey } from '../useBoxes'

export type { CreateBoxParams }

export const useCreateBoxMutation = () => {
  const api = useApi()
  const { selectedOrganization } = useSelectedOrganization()
  const queryClient = useQueryClient()

  return useMutation<Box, unknown, CreateBoxParams>({
    mutationFn: async (params) => {
      if (!selectedOrganization?.id) throw new Error('Missing organization')
      const created = await createBoxViaBoxApi(api, selectedOrganization.id, params)
      // The Box API response is dialect-shaped (box_id/status); re-read through
      // the cloud api-client so callers keep the full organization-scoped Box.
      return (await api.boxApi.getBox(created.box_id, selectedOrganization.id)).data
    },
    onSuccess: async () => {
      if (selectedOrganization?.id) {
        await queryClient.invalidateQueries({ queryKey: getBoxesQueryKey(selectedOrganization.id) })
      }
    },
  })
}
