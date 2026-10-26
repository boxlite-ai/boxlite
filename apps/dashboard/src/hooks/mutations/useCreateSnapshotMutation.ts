/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useApi } from '../useApi'
import { getBoxesQueryKey } from '../useBoxes'
import { queryKeys } from '../queries/queryKeys'
import { createSnapshot } from '@/lib/cloudSnapshot'

export function useCreateSnapshotMutation() {
  const api = useApi()
  const client = useQueryClient()
  return useMutation({
    mutationFn: async ({ boxId, name, organizationId }: { boxId: string; name: string; organizationId?: string }) => {
      if (!organizationId) throw new Error('No organization selected')
      return createSnapshot(api, organizationId, boxId, name.trim() || undefined)
    },
    onSuccess: async (_snapshot, { organizationId }) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.snapshots.list(organizationId!) }),
        client.invalidateQueries({ queryKey: getBoxesQueryKey(organizationId) }),
      ])
    },
  })
}
