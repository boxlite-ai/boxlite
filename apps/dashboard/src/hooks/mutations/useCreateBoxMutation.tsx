/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxliteError } from '@/api/errors'
import { useApi } from '@/hooks/useApi'
import { CreateBoxParams, createBoxViaBoxApi } from '@/lib/cloudBox'
import type { Box } from '@boxlite-ai/api-client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { isAxiosError } from 'axios'
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
      let boxId: string
      try {
        boxId = (await createBoxViaBoxApi(api, selectedOrganization.id, params)).box_id
      } catch (error) {
        // The server may finish waiting before a cold image finishes pulling.
        // Only its explicit identity proves a box exists; never repeat POST.
        if (error instanceof BoxliteError) {
          if (error.statusCode !== 408) throw error
        } else if (!isAxiosError(error) || error.response?.status !== 408) {
          throw error
        }
        const pendingBoxId = error instanceof BoxliteError ? error.boxId : error.response?.data?.boxId
        if (typeof pendingBoxId !== 'string' || pendingBoxId.length === 0) throw error
        boxId = pendingBoxId
      }
      // The Box API response is dialect-shaped (box_id/status); re-read through
      // the cloud api-client so callers keep the full organization-scoped Box.
      return (await api.boxApi.getBox(boxId, selectedOrganization.id)).data
    },
    onSuccess: async () => {
      if (selectedOrganization?.id) {
        await queryClient.invalidateQueries({ queryKey: getBoxesQueryKey(selectedOrganization.id) })
      }
    },
  })
}
