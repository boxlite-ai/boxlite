/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useQuery } from '@tanstack/react-query'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { queryKeys } from '@/hooks/queries/queryKeys'
import {
  ModelsAggregatedUsage,
  ModelsBoxUsage,
  ModelsUsageChartPoint,
  ModelsUsagePeriod,
} from '@boxlite-ai/analytics-api-client'

export interface AnalyticsUsageParams {
  from: Date
  to: Date
  enabled?: boolean
}

export function useAggregatedUsage(params: AnalyticsUsageParams) {
  const api = useApi()
  const { selectedOrganization } = useSelectedOrganization()

  return useQuery<ModelsAggregatedUsage>({
    queryKey: queryKeys.analytics.aggregatedUsage(selectedOrganization?.id ?? '', params),
    queryFn: async () => {
      if (!selectedOrganization || !api.analyticsUsageApi) {
        throw new Error('Missing required parameters')
      }
      const response = await api.analyticsUsageApi.organizationOrganizationIdUsageAggregatedGet(
        selectedOrganization.id,
        params.from.toISOString(),
        params.to.toISOString(),
      )
      return response.data
    },
    enabled: !!selectedOrganization && !!api.analyticsUsageApi && params.enabled !== false,
    staleTime: 10_000,
  })
}

export function useBoxesUsage(params: AnalyticsUsageParams) {
  const api = useApi()
  const { selectedOrganization } = useSelectedOrganization()

  return useQuery<ModelsBoxUsage[]>({
    queryKey: queryKeys.analytics.boxesUsage(selectedOrganization?.id ?? '', params),
    queryFn: async () => {
      if (!selectedOrganization || !api.analyticsUsageApi) {
        throw new Error('Missing required parameters')
      }
      const response = await api.analyticsUsageApi.organizationOrganizationIdUsageBoxGet(
        selectedOrganization.id,
        params.from.toISOString(),
        params.to.toISOString(),
      )
      return response.data
    },
    enabled: !!selectedOrganization && !!api.analyticsUsageApi && params.enabled !== false,
    staleTime: 10_000,
  })
}

export interface UsageChartParams extends AnalyticsUsageParams {
  region?: string
}

export function useUsageChart(params: UsageChartParams) {
  const api = useApi()
  const { selectedOrganization } = useSelectedOrganization()

  return useQuery<ModelsUsageChartPoint[]>({
    queryKey: queryKeys.analytics.usageChart(selectedOrganization?.id ?? '', params),
    queryFn: async () => {
      if (!selectedOrganization || !api.analyticsUsageApi) {
        throw new Error('Missing required parameters')
      }
      const response = await api.analyticsUsageApi.organizationOrganizationIdUsageChartGet(
        selectedOrganization.id,
        params.from.toISOString(),
        params.to.toISOString(),
        params.region,
      )
      return response.data
    },
    enabled: !!selectedOrganization && !!api.analyticsUsageApi && params.enabled !== false,
    staleTime: 10_000,
  })
}

export function useBoxUsagePeriods(boxId: string | undefined, params: AnalyticsUsageParams) {
  const api = useApi()
  const { selectedOrganization } = useSelectedOrganization()

  return useQuery<ModelsUsagePeriod[]>({
    queryKey: queryKeys.analytics.boxUsagePeriods(selectedOrganization?.id ?? '', boxId ?? '', params),
    queryFn: async () => {
      if (!selectedOrganization || !boxId || !api.analyticsUsageApi) {
        throw new Error('Missing required parameters')
      }
      const response = await api.analyticsUsageApi.organizationOrganizationIdBoxBoxIdUsageGet(
        selectedOrganization.id,
        boxId,
        params.from.toISOString(),
        params.to.toISOString(),
      )
      return response.data
    },
    enabled: !!boxId && !!selectedOrganization && !!api.analyticsUsageApi && params.enabled !== false,
    staleTime: 10_000,
  })
}
