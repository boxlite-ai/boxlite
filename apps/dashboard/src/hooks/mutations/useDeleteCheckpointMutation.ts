/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useApi } from '../useApi'
import { queryKeys } from '../queries/queryKeys'

export function useDeleteCheckpointMutation() {
  const api = useApi()
  const client = useQueryClient()
  return useMutation({
    mutationFn: async ({ checkpointId, organizationId }: { checkpointId: string; organizationId?: string }) => {
      if (!organizationId) throw new Error('No organization selected')
      await api.removeCheckpoint(organizationId, checkpointId)
    },
    onSuccess: async (_data, { organizationId }) => {
      if (!organizationId) return
      await client.invalidateQueries({ queryKey: queryKeys.checkpoints.list(organizationId) })
    },
  })
}
