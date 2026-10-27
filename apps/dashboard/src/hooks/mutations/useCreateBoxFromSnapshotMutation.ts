/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createBoxFromSnapshot } from '@/lib/cloudSnapshot'
import { useApi } from '../useApi'
import { getBoxesQueryKey } from '../useBoxes'

export function useCreateBoxFromSnapshotMutation() {
  const api = useApi()
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ snapshotId, name, organizationId }: { snapshotId: string; name: string; organizationId: string }) =>
      createBoxFromSnapshot(api, organizationId, snapshotId, name.trim() || undefined),
    onSuccess: async (_box, { organizationId }) => {
      await client.invalidateQueries({ queryKey: getBoxesQueryKey(organizationId) })
    },
  })
}
