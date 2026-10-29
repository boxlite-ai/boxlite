/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { Organization } from '@boxlite-ai/api-client'
import { useQuery } from '@tanstack/react-query'
import { useApi } from '../useApi'
import { queryKeys } from './queryKeys'

export function useOrganizationBoxLimitsQuery(
  organization: Organization | null,
  { enabled = true, poll = false } = {},
) {
  const { organizationsApi } = useApi()

  return useQuery({
    queryKey: [
      ...queryKeys.organization.detail(organization?.id ?? ''),
      'box-limits',
      // An administrator can change stored quotas without changing the ID.
      organization?.maxCpuPerBox,
      organization?.maxMemoryPerBox,
      organization?.maxDiskPerBox,
    ],
    queryFn: async ({ signal }) => {
      if (!organization?.id) throw new Error('No organization selected')
      return (await organizationsApi.getOrganization(organization.id, { signal, timeout: 10_000 })).data
    },
    enabled: enabled && !!organization?.id,
    staleTime: 0,
    // Override the global keepPreviousData: another org's limits are never a fallback.
    placeholderData: undefined,
    retry: false,
    refetchInterval: poll ? 10_000 : false,
    refetchIntervalInBackground: false,
  })
}
