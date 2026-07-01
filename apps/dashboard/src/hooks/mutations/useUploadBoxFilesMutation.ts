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

interface UploadBoxFilesResult {
  organizationId: string
  uploadedPaths: string[]
}

interface UploadBoxFilesContext {
  organizationId?: string
}

export const useUploadBoxFilesMutation = () => {
  const api = useApi()
  const { selectedOrganization } = useSelectedOrganization()
  const queryClient = useQueryClient()

  const invalidateBoxDetail = (organizationId: string, boxId: string, detailRef?: string) => {
    queryClient.invalidateQueries({
      queryKey: queryKeys.boxes.detail(organizationId, boxId),
    })
    if (detailRef && detailRef !== boxId) {
      queryClient.invalidateQueries({
        queryKey: queryKeys.boxes.detail(organizationId, detailRef),
      })
    }
  }

  return useMutation<UploadBoxFilesResult, unknown, UploadBoxFilesVariables, UploadBoxFilesContext>({
    onMutate: () => ({
      organizationId: selectedOrganization?.id,
    }),
    mutationFn: async ({ boxId, items, destinationDir = DEFAULT_BOX_UPLOAD_DIR }: UploadBoxFilesVariables) => {
      const organizationId = selectedOrganization?.id
      if (!organizationId) {
        throw new Error(`Cannot upload files to box ${boxId}: no organization selected`)
      }

      const uploadedPaths: string[] = []
      for (const item of items) {
        uploadedPaths.push(await uploadBoxItemViaBoxApi(api, organizationId, boxId, item, destinationDir))
      }
      return { organizationId, uploadedPaths }
    },
    onSettled: (data, _error, variables, context) => {
      const organizationId = data?.organizationId ?? context?.organizationId
      if (variables && organizationId) {
        invalidateBoxDetail(organizationId, variables.boxId, variables.detailRef)
      }
    },
  })
}
