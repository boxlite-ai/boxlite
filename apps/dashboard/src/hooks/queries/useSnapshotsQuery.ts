/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { SnapshotStatus, listSnapshots } from '@/lib/cloudSnapshot'
import { useQuery } from '@tanstack/react-query'
import { SNAPSHOT_POLL_INTERVAL, snapshotsDisabled } from '@/lib/snapshots'
import { useApi } from '../useApi'
import { useSelectedOrganization } from '../useSelectedOrganization'
import { queryKeys } from './queryKeys'

export function useSnapshotsQuery() {
  const api = useApi()
  const { selectedOrganization } = useSelectedOrganization()
  return useQuery({
    queryKey: queryKeys.snapshots.list(selectedOrganization?.id ?? ''),
    queryFn: async () => {
      if (!selectedOrganization) throw new Error('No organization selected')
      return listSnapshots(api, selectedOrganization.id)
    },
    enabled: !!selectedOrganization,
    retry: (count, error) => !snapshotsDisabled(error) && count < 2,
    refetchInterval: (query) =>
      query.state.status !== 'error' &&
      query.state.data?.some((snapshot) => snapshot.status === SnapshotStatus.CREATING)
        ? SNAPSHOT_POLL_INTERVAL
        : false,
  })
}
