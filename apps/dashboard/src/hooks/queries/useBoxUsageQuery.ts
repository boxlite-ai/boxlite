/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import type { BoxUsagePeriodRow, BoxUsageTotals } from '@/lib/usage-verification'
import { useQuery } from '@tanstack/react-query'
import { queryKeys } from './queryKeys'

export function useBoxUsageQuery(boxId: string | undefined, autoRefresh: boolean) {
  const api = useApi()
  const { selectedOrganization } = useSelectedOrganization()

  return useQuery<BoxUsageTotals>({
    queryKey: queryKeys.boxes.usage(selectedOrganization?.id ?? '', boxId ?? ''),
    queryFn: () => api.getBoxUsage(boxId ?? '', selectedOrganization?.id ?? ''),
    enabled: !!selectedOrganization?.id && !!boxId,
    refetchInterval: autoRefresh ? 3000 : false,
    staleTime: 1000,
    retry: false,
  })
}

export function useBoxUsagePeriodsQuery(boxId: string | undefined, autoRefresh: boolean) {
  const api = useApi()
  const { selectedOrganization } = useSelectedOrganization()

  return useQuery<BoxUsagePeriodRow[]>({
    queryKey: queryKeys.boxes.usagePeriods(selectedOrganization?.id ?? '', boxId ?? ''),
    queryFn: () => api.getBoxUsagePeriods(boxId ?? '', selectedOrganization?.id ?? ''),
    enabled: !!selectedOrganization?.id && !!boxId,
    refetchInterval: autoRefresh ? 3000 : false,
    staleTime: 1000,
    retry: false,
  })
}
