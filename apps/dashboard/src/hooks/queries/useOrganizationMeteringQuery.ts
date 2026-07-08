/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { OrganizationMetering, OrganizationMeteringParams } from '@/billing-api'
import { useQuery } from '@tanstack/react-query'
import { useApi } from '../useApi'
import { queryKeys } from './queryKeys'

export const useOrganizationMeteringQuery = ({
  organizationId,
  enabled = true,
  params = {},
}: {
  organizationId: string
  enabled?: boolean
  params?: OrganizationMeteringParams
}) => {
  const { billingApi } = useApi()

  return useQuery<OrganizationMetering>({
    queryKey: queryKeys.organization.metering(organizationId, params),
    queryFn: () => billingApi.getOrganizationMetering(organizationId, params),
    enabled: Boolean(enabled && organizationId),
  })
}
