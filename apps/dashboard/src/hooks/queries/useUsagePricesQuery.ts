/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { UsagePrices } from '@/billing-api'
import { useQuery } from '@tanstack/react-query'
import { useApi } from '../useApi'
import { useConfig } from '../useConfig'
import { queryKeys } from './queryKeys'

export const useUsagePricesQuery = ({ enabled = true }: { enabled?: boolean } = {}) => {
  const { billingApi } = useApi()
  const config = useConfig()

  return useQuery<UsagePrices>({
    queryKey: queryKeys.billing.usagePrices(),
    queryFn: () => billingApi.getUsagePrices(),
    // Not organization-scoped: one price list serves every tenant. Without a
    // billing service there is no price to quote, so the caller falls back.
    enabled: Boolean(enabled && config.billingApiUrl),
    // Commerce reads these from boot-time configuration, so they only move on a
    // redeploy. An hour picks a price change up without a refetch per dialog.
    staleTime: 60 * 60 * 1000,
  })
}
