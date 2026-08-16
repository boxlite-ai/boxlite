/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { SeriesGranularity, UsageFundingBucket } from '@/billing-api'
import { useQuery } from '@tanstack/react-query'
import { useApi } from '../useApi'
import { useConfig } from '../useConfig'
import { queryKeys } from './queryKeys'

/**
 * The funding-split series: settlement money bucketed by when it moved, split
 * quota-covered vs from-wallet. This is billing-service data — real ledger
 * movements — not the analytics resource series, so it needs only
 * `billingApiUrl` to exist.
 */
export const useUsageFundingSeriesQuery = ({
  organizationId,
  granularity,
  from,
  to,
  enabled = true,
}: {
  organizationId: string
  granularity: SeriesGranularity
  from: Date
  to: Date
  enabled?: boolean
}) => {
  const { billingApi } = useApi()
  const config = useConfig()

  return useQuery<UsageFundingBucket[]>({
    queryKey: queryKeys.organization.usage.series(organizationId, {
      granularity,
      from: from.toISOString(),
      to: to.toISOString(),
    }),
    queryFn: () => billingApi.getUsageFundingSeries(organizationId, granularity, from, to),
    enabled: Boolean(enabled && organizationId && config.billingApiUrl),
  })
}
