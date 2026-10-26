/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0 */

import { useQuery } from '@tanstack/react-query'
import { getSnapshotCapabilities } from '@/lib/cloudSnapshot'
import { useApi } from '../useApi'
import { useSelectedOrganization } from '../useSelectedOrganization'

export function useSnapshotCapabilities() {
  const api = useApi()
  const { selectedOrganization } = useSelectedOrganization()
  return useQuery({
    queryKey: ['snapshot-capabilities', selectedOrganization?.id],
    queryFn: () => getSnapshotCapabilities(api),
    enabled: !!selectedOrganization,
  })
}
