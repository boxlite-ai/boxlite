/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { OrganizationPlan } from '@/billing-api'
import { useQuery } from '@tanstack/react-query'
import { useApi } from '../useApi'
import { useConfig } from '../useConfig'
import { queryKeys } from './queryKeys'

export const useOrganizationPlanQuery = ({
  organizationId,
  enabled = true,
}: {
  organizationId: string
  enabled?: boolean
}) => {
  const { billingApi } = useApi()
  const config = useConfig()

  return useQuery<OrganizationPlan | null>({
    queryKey: queryKeys.organization.plan(organizationId),
    queryFn: () => billingApi.getOrganizationPlan(organizationId),
    enabled: Boolean(enabled && organizationId && config.billingApiUrl),
  })
}
