/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { OrganizationUsageOverview } from '@boxlite-ai/api-client'
import { useQuery } from '@tanstack/react-query'
import { useApi } from '../useApi'
import { queryKeys } from './queryKeys'

export const useOrganizationUsageOverviewQuery = (
  { organizationId }: { organizationId: string },
  options?: Omit<Parameters<typeof useQuery<OrganizationUsageOverview>>[0], 'queryKey' | 'queryFn'>,
) => {
  const { organizationsApi } = useApi()

  return useQuery<OrganizationUsageOverview>({
    queryKey: queryKeys.organization.usage.overview(organizationId),
    queryFn: async () => (await organizationsApi.getOrganizationUsageOverview(organizationId)).data,
    enabled: !!organizationId,
    ...options,
  })
}
