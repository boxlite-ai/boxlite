/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useApi } from '../useApi'
import { queryKeys } from '../queries/queryKeys'
import { deleteSnapshot } from '@/lib/cloudSnapshot'

export function useDeleteSnapshotMutation() {
  const api = useApi()
  const client = useQueryClient()
  return useMutation({
    mutationFn: async ({ snapshotId, organizationId }: { snapshotId: string; organizationId?: string }) => {
      if (!organizationId) throw new Error('No organization selected')
      await deleteSnapshot(api, organizationId, snapshotId)
    },
    onSuccess: async (_data, { organizationId }) => {
      await client.invalidateQueries({ queryKey: queryKeys.snapshots.list(organizationId!) })
    },
  })
}
