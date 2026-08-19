/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { OrganizationConcurrencyDto } from '@boxlite-ai/api-client'
import { useQuery, UseQueryOptions } from '@tanstack/react-query'
import { useApi } from '../useApi'
import { queryKeys } from './queryKeys'

export function useOrganizationConcurrencyQuery({
  organizationId,
  hours = 24,
  enabled = true,
  ...queryOptions
}: {
  organizationId: string | undefined
  hours?: number
  enabled?: boolean
} & Omit<UseQueryOptions<OrganizationConcurrencyDto>, 'queryKey' | 'queryFn'>) {
  const { organizationsApi } = useApi()

  return useQuery<OrganizationConcurrencyDto>({
    queryKey: queryKeys.organization.concurrency(organizationId ?? '', hours),
    queryFn: async () => {
      if (!organizationId) throw new Error('Organization ID is required to load concurrency')
      return (await organizationsApi.getOrganizationConcurrency(organizationId, hours)).data
    },
    enabled: Boolean(enabled && organizationId),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    ...queryOptions,
  })
}
