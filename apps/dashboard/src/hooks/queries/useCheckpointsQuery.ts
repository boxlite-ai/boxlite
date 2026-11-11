/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CheckpointStatus } from '@/api/checkpoint-types'
import { useQuery } from '@tanstack/react-query'
import { CHECKPOINT_POLL_INTERVAL } from '@/lib/checkpoints'
import { useApi } from '../useApi'
import { useSelectedOrganization } from '../useSelectedOrganization'
import { queryKeys } from './queryKeys'

export function useCheckpointsQuery(enabled = true) {
  const api = useApi()
  const { selectedOrganization } = useSelectedOrganization()
  return useQuery({
    queryKey: queryKeys.checkpoints.list(selectedOrganization?.id ?? ''),
    queryFn: async () => {
      if (!selectedOrganization) throw new Error('No organization selected')
      return api.listCheckpoints(selectedOrganization.id)
    },
    enabled: enabled && !!selectedOrganization,
    retry: (count) => count < 2,
    refetchInterval: (query) =>
      query.state.status !== 'error' &&
      query.state.data?.some(
        (checkpoint) =>
          checkpoint.state === CheckpointStatus.CREATING || checkpoint.state === CheckpointStatus.DELETING,
      )
        ? CHECKPOINT_POLL_INTERVAL
        : false,
  })
}
