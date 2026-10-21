/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import type { AppDetail, AppSummary, EnvironmentSummary } from '@/lib/apps/types'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { queryKeys } from './queryKeys'

// Apps have no generated client yet: the contract is a design mock served by
// MSW. The raw axios instance carries the same base path and bearer token the
// generated clients use, so these read like the rest of the data layer.
export function useAppsQuery() {
  const api = useApi()
  const { selectedOrganization } = useSelectedOrganization()

  return useQuery<AppSummary[]>({
    queryKey: queryKeys.apps.list(selectedOrganization?.id ?? ''),
    queryFn: async () => {
      const response = await api.axiosInstance.get<AppSummary[]>('/apps')
      return response.data
    },
    enabled: !!selectedOrganization,
  })
}

/** The environment the app page shows, from ?env= (production when absent). */
export function useAppEnv(): string {
  const [searchParams] = useSearchParams()
  return searchParams.get('env') || 'production'
}

export function useAppQuery(appId: string) {
  const api = useApi()
  const { selectedOrganization } = useSelectedOrganization()
  const env = useAppEnv()

  return useQuery<AppDetail>({
    queryKey: queryKeys.apps.detail(selectedOrganization?.id ?? '', appId, env),
    queryFn: async () => {
      const response = await api.axiosInstance.get<AppDetail>(`/apps/${encodeURIComponent(appId)}`, {
        params: { env },
      })
      return response.data
    },
    enabled: !!appId && !!selectedOrganization,
    retry: false,
    // A not-yet-deployed environment is waiting on the agent; poll so its first deployment shows up unprompted.
    refetchInterval: (query) => (query.state.data?.status === 'draft' ? 5000 : false),
  })
}

export function useAppEnvironments(appId: string) {
  const api = useApi()
  const { selectedOrganization } = useSelectedOrganization()

  return useQuery<EnvironmentSummary[]>({
    queryKey: queryKeys.apps.environments(selectedOrganization?.id ?? '', appId),
    queryFn: async () => {
      const response = await api.axiosInstance.get<EnvironmentSummary[]>(
        `/apps/${encodeURIComponent(appId)}/environments`,
      )
      return response.data
    },
    enabled: !!appId && !!selectedOrganization,
  })
}
