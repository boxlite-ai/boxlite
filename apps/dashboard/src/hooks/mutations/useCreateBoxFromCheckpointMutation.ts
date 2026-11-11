/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useApi } from '../useApi'
import { getBoxesQueryKey } from '../useBoxes'
import { checkpointAdmittedBoxId } from '@/lib/checkpoints'

export function useCreateBoxFromCheckpointMutation() {
  const api = useApi()
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({
      checkpointId,
      name,
      organizationId,
    }: {
      checkpointId: string
      name: string
      organizationId: string
    }) => api.createBoxFromCheckpoint(organizationId, checkpointId, name.trim() || undefined),
    onSettled: async (_box, error, { organizationId }) => {
      if (error && !checkpointAdmittedBoxId(error)) return
      await client.invalidateQueries({ queryKey: getBoxesQueryKey(organizationId) })
      await client.invalidateQueries({ queryKey: ['boxesCount', organizationId] })
    },
  })
}
