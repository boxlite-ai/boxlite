/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../queries/queryKeys'
import { useApi } from '../useApi'

interface AliasVariables {
  idOrRef: string
  alias: string
  organizationId?: string
}

/**
 * Pins a tag to a version. The API refuses an existing name with 409, even
 * for the same version; the page shows that, it does not retry as an update.
 */
export const usePinImageTagMutation = () => {
  const { imageApi } = useApi()
  const queryClient = useQueryClient()

  return useMutation<void, unknown, AliasVariables & { versionId: string }>({
    mutationFn: async ({ idOrRef, alias, versionId, organizationId }) => {
      if (!organizationId) {
        throw new Error('No organization selected')
      }
      await imageApi.createImageAlias(idOrRef, { alias, versionId }, organizationId)
    },
    onSuccess: (_data, { organizationId }) => invalidateImage(queryClient, organizationId),
  })
}

export const useUnpinImageTagMutation = () => {
  const { imageApi } = useApi()
  const queryClient = useQueryClient()

  return useMutation<void, unknown, AliasVariables>({
    mutationFn: async ({ idOrRef, alias, organizationId }) => {
      if (!organizationId) {
        throw new Error('No organization selected')
      }
      await imageApi.deleteImageAlias(idOrRef, alias, organizationId)
    },
    onSuccess: (_data, { organizationId }) => invalidateImage(queryClient, organizationId),
  })
}

// The list carries each image's tags too, so both reads move together.
async function invalidateImage(queryClient: ReturnType<typeof useQueryClient>, organizationId?: string) {
  if (!organizationId) return
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.images.details(organizationId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.images.list(organizationId) }),
  ])
}
