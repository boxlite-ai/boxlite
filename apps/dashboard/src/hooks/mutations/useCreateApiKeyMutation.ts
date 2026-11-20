/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiKeyResponse } from '@boxlite-ai/api-client'
import { ResourcePermission, splitResourcePermissions } from '@/lib/resource-permissions'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../queries/queryKeys'
import { useApi } from '../useApi'

export interface CreateApiKeyMutationVariables {
  name: string
  permissions: ResourcePermission[]
  expiresAt: Date | null
  organizationId?: string
}

export const useCreateApiKeyMutation = () => {
  const { apiKeyApi } = useApi()
  const queryClient = useQueryClient()

  return useMutation<ApiKeyResponse, unknown, CreateApiKeyMutationVariables>({
    mutationFn: async ({ organizationId, name, permissions: selection, expiresAt }) => {
      const { permissions, proxyPermissions } = splitResourcePermissions(selection)
      const response = await apiKeyApi.createApiKey(
        {
          name,
          permissions,
          ...(proxyPermissions.length ? { proxyPermissions } : {}),
          expiresAt: expiresAt ?? undefined,
        },
        organizationId,
      )

      return response.data
    },
    onSuccess: async (_data, { organizationId }) => {
      if (organizationId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.list(organizationId) })
      }
    },
  })
}
