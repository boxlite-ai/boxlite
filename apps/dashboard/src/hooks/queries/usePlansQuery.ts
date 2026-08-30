/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { Plan } from '@/billing-api'
import { useQuery } from '@tanstack/react-query'
import { useApi } from '../useApi'
import { useConfig } from '../useConfig'
import { queryKeys } from './queryKeys'

export const usePlansQuery = ({ enabled = true }: { enabled?: boolean } = {}) => {
  const { billingApi } = useApi()
  const config = useConfig()

  return useQuery<Plan[]>({
    queryKey: queryKeys.billing.plans(),
    queryFn: () => billingApi.listPlans(),
    enabled: Boolean(enabled && config.billingApiUrl),
  })
}
