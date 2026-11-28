/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0 */

import { useQuery } from '@tanstack/react-query'
import { useApi } from '../useApi'
import { useSelectedOrganization } from '../useSelectedOrganization'

export function useVolumeStorageCapabilities() {
  const api = useApi()
  const { selectedOrganization } = useSelectedOrganization()
  return useQuery({
    queryKey: ['volume-storage-capabilities', selectedOrganization?.id],
    queryFn: () => api.getVolumeStorageCapabilities(),
    enabled: !!selectedOrganization,
  })
}
