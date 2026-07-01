/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { uploadBoxItemViaBoxApi } from '@/lib/cloudBox'
import { DEFAULT_BOX_UPLOAD_DIR, type BoxUploadItem } from '@/lib/box-upload'
import { useMutation, useQueryClient } from '@tanstack/react-query'

interface UploadBoxFilesVariables {
  boxId: string
  detailRef?: string
  destinationDir?: string
  items: BoxUploadItem[]
}

export const useUploadBoxFilesMutation = () => {
  const api = useApi()
  const { selectedOrganization } = useSelectedOrganization()
  const queryClient = useQueryClient()

  const invalidateBoxDetail = (boxId: string, detailRef?: string) => {
    queryClient.invalidateQueries({
      queryKey: queryKeys.boxes.detail(selectedOrganization?.id ?? '', boxId),
    })
    if (detailRef && detailRef !== boxId) {
      queryClient.invalidateQueries({
        queryKey: queryKeys.boxes.detail(selectedOrganization?.id ?? '', detailRef),
      })
    }
  }

  return useMutation({
    mutationFn: async ({ boxId, items, destinationDir = DEFAULT_BOX_UPLOAD_DIR }: UploadBoxFilesVariables) => {
      if (!selectedOrganization?.id) throw new Error('Missing organization')

      const uploadedPaths: string[] = []
      for (const item of items) {
        uploadedPaths.push(await uploadBoxItemViaBoxApi(api, selectedOrganization.id, boxId, item, destinationDir))
      }
      return uploadedPaths
    },
    onSettled: (_data, _error, variables) => {
      if (variables) {
        invalidateBoxDetail(variables.boxId, variables.detailRef)
      }
    },
  })
}
