/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useApi } from '../useApi'
import { useSelectedOrganization } from '../useSelectedOrganization'
import { getSandboxesQueryKey } from '../useSandboxes'
import type { Sandbox } from '@boxlite-ai/api-client'

export interface CreateSandboxFromTemplateParams {
  name?: string
  templateId: string
  public?: boolean
  networkBlockAll?: boolean
  autoStopInterval?: number
  autoDeleteInterval?: number
  cpu?: number
  memory?: number
  disk?: number
}

export const useCreateSandboxFromTemplateMutation = () => {
  const { axiosInstance } = useApi()
  const { selectedOrganization } = useSelectedOrganization()
  const queryClient = useQueryClient()

  return useMutation<Sandbox, unknown, CreateSandboxFromTemplateParams>({
    mutationFn: async (params) => {
      if (!selectedOrganization?.id) {
        throw new Error('Missing organization')
      }

      const response = await axiosInstance.post<Sandbox>('/sandbox', params, {
        headers: {
          'X-BoxLite-Organization-ID': selectedOrganization.id,
        },
      })

      return response.data
    },
    onSuccess: async () => {
      if (selectedOrganization?.id) {
        await queryClient.invalidateQueries({ queryKey: getSandboxesQueryKey(selectedOrganization.id) })
      }
    },
  })
}
