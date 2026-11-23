/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0 */

import { useQuery } from '@tanstack/react-query'
import { useApi } from '../useApi'
import { useSelectedOrganization } from '../useSelectedOrganization'

export function useCheckpointCapabilities() {
  const api = useApi()
  const { selectedOrganization } = useSelectedOrganization()
  return useQuery({
    queryKey: ['checkpoint-capabilities', selectedOrganization?.id],
    queryFn: () => api.getCheckpointCapabilities(),
    enabled: !!selectedOrganization,
  })
}
