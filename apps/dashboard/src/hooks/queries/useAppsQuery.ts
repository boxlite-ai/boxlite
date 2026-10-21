/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { appsClient } from '@/lib/apps/client'
import {
  RELEASE_IN_PROGRESS,
  type AppAuthDetail,
  type AppDatabaseDetail,
  type AppDetail,
  type AppLogLine,
  type AppSummary,
  type ConsoleSession,
  type EnvironmentSummary,
  type QueryResult,
  type ReleaseLog,
} from '@/lib/apps/types'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { queryKeys } from './queryKeys'

// Apps are served by the Micro-cloud control plane's console API, which is not
// organization-scoped: the console signs in to one control plane.
export const APPS_SCOPE = 'console'

const busy = (app: AppDetail | undefined) =>
  !!app && (app.status === 'building' || app.releases.some((r) => RELEASE_IN_PROGRESS.includes(r.status)))

export function useConsoleSession() {
  return useQuery<ConsoleSession>({
    queryKey: [...queryKeys.apps.all, APPS_SCOPE, 'session'],
    queryFn: async () => (await appsClient.get<ConsoleSession>('/session')).data,
    staleTime: Infinity,
  })
}

export function useAppsQuery() {
  return useQuery<AppSummary[]>({
    queryKey: queryKeys.apps.list(APPS_SCOPE),
    queryFn: async () => (await appsClient.get<AppSummary[]>('/apps')).data,
    // A deployment started by an agent shows up without a reload.
    refetchInterval: 10_000,
  })
}

/** The environment the app page shows, from ?env= (main when absent). */
export function useAppEnv(): string {
  const [searchParams] = useSearchParams()
  return searchParams.get('env') || 'main'
}

export function useAppQuery(appId: string) {
  const env = useAppEnv()
  return useQuery<AppDetail>({
    queryKey: queryKeys.apps.detail(APPS_SCOPE, appId, env),
    queryFn: async () =>
      (await appsClient.get<AppDetail>(`/apps/${encodeURIComponent(appId)}`, { params: { env } })).data,
    enabled: !!appId,
    retry: false,
    // A deployment in progress (or the agent's first one) is followed as it happens.
    refetchInterval: (query) => (busy(query.state.data) ? 2500 : query.state.data?.status === 'draft' ? 5000 : 15_000),
  })
}

export function useAppEnvironments(appId: string) {
  return useQuery<EnvironmentSummary[]>({
    queryKey: queryKeys.apps.environments(APPS_SCOPE, appId),
    queryFn: async () =>
      (await appsClient.get<EnvironmentSummary[]>(`/apps/${encodeURIComponent(appId)}/environments`)).data,
    enabled: !!appId,
  })
}

export function useAppLogs(appId: string, since: string, live: boolean) {
  const env = useAppEnv()
  return useQuery<AppLogLine[]>({
    queryKey: [...queryKeys.apps.detail(APPS_SCOPE, appId, env), 'logs', since],
    queryFn: async () =>
      (
        await appsClient.get<AppLogLine[]>(`/apps/${encodeURIComponent(appId)}/logs`, {
          params: { env, since, limit: 2000 },
        })
      ).data,
    refetchInterval: live ? 3000 : false,
    placeholderData: keepPreviousData,
  })
}

export function useReleaseLog(appId: string, number: number, enabled: boolean, inProgress: boolean) {
  const env = useAppEnv()
  return useQuery<ReleaseLog>({
    queryKey: [...queryKeys.apps.detail(APPS_SCOPE, appId, env), 'release', number],
    queryFn: async () =>
      (
        await appsClient.get<ReleaseLog>(`/apps/${encodeURIComponent(appId)}/deployments/${number}`, {
          params: { env },
        })
      ).data,
    enabled,
    refetchInterval: inProgress ? 2000 : false,
  })
}

export function useAppDatabase(appId: string, enabled = true) {
  const env = useAppEnv()
  return useQuery<AppDatabaseDetail>({
    queryKey: [...queryKeys.apps.detail(APPS_SCOPE, appId, env), 'database'],
    queryFn: async () =>
      (await appsClient.get<AppDatabaseDetail>(`/apps/${encodeURIComponent(appId)}/database`, { params: { env } }))
        .data,
    enabled,
    retry: false,
  })
}

export function useTableRows(appId: string, table: string, search: string, limit: number, offset: number) {
  const env = useAppEnv()
  return useQuery<QueryResult>({
    queryKey: [...queryKeys.apps.detail(APPS_SCOPE, appId, env), 'rows', table, search, limit, offset],
    queryFn: async () =>
      (
        await appsClient.get<QueryResult>(
          `/apps/${encodeURIComponent(appId)}/database/rows/${encodeURIComponent(table)}`,
          { params: { env, search, limit, offset } },
        )
      ).data,
    placeholderData: keepPreviousData,
    retry: false,
  })
}

/** The org secrets a variable may reference (names only). */
export function useOrgSecrets(enabled: boolean) {
  return useQuery<{ name: string; updated_at: string }[]>({
    queryKey: [...queryKeys.apps.all, APPS_SCOPE, 'secrets'],
    queryFn: async () => (await appsClient.get<{ name: string; updated_at: string }[]>('/secrets')).data,
    enabled,
  })
}

export function useAppAuth(appId: string) {
  const env = useAppEnv()
  return useQuery<AppAuthDetail>({
    queryKey: [...queryKeys.apps.detail(APPS_SCOPE, appId, env), 'auth'],
    queryFn: async () =>
      (await appsClient.get<AppAuthDetail>(`/apps/${encodeURIComponent(appId)}/auth`, { params: { env } })).data,
  })
}
