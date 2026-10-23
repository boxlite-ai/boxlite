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
  type DeletedApp,
  type DeploymentDetail,
  type EnvironmentSummary,
  type QueryResult,
  type VolumeListing,
} from '@/lib/apps/types'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { queryKeys } from './queryKeys'

// Apps are served by the Micro-cloud control plane's console API, which is not
// organization-scoped: the console signs in to one control plane.
export const APPS_SCOPE = 'console'

export const isBusy = (app: AppDetail | undefined) =>
  !!app && (app.status === 'building' || app.releases.some((r) => RELEASE_IN_PROGRESS.includes(r.status)))

/** How often a busy environment is re-read: the header and Deployments row follow a deploy within this. */
const LIVE_MS = 1500

export function useConsoleSession({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery<ConsoleSession>({
    // Under the App list, so creating, deleting or restoring an App refreshes the org's App count too.
    queryKey: [...queryKeys.apps.list(APPS_SCOPE), 'session'],
    queryFn: async () => (await appsClient.get<ConsoleSession>('/session')).data,
    staleTime: 30_000,
    enabled,
  })
}

export function useAppsQuery() {
  return useQuery<AppSummary[]>({
    queryKey: queryKeys.apps.list(APPS_SCOPE),
    queryFn: async () => (await appsClient.get<AppSummary[]>('/apps')).data,
    // A deployment started by an agent shows up without a reload, and is followed while it runs.
    refetchInterval: (query) => (query.state.data?.some((app) => app.progress) ? 2000 : 10_000),
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
    refetchInterval: (query) =>
      isBusy(query.state.data) ? LIVE_MS : query.state.data?.status === 'draft' ? 5000 : 15_000,
  })
}

/**
 * When a deployment of this environment finishes, everything it may have changed is read again:
 * services, database tables (migrations), variables, volumes, logs, environments.
 */
export function useRefreshOnDeployDone(app: AppDetail | undefined) {
  const queryClient = useQueryClient()
  const wasBusy = useRef(false)
  const busyNow = isBusy(app)
  useEffect(() => {
    if (wasBusy.current && !busyNow && app) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apps.detail(APPS_SCOPE, app.id) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.apps.list(APPS_SCOPE) })
    }
    wasBusy.current = busyNow
  }, [busyNow, app, queryClient])
}

/** Soft-deleted apps, restorable until their purge date. */
export function useDeletedApps() {
  return useQuery<DeletedApp[]>({
    queryKey: [...queryKeys.apps.all, APPS_SCOPE, 'deleted'],
    queryFn: async () => (await appsClient.get<DeletedApp[]>('/deleted-apps')).data,
    refetchInterval: 30_000,
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

export function useAppLogs(appId: string, since: string, live: boolean, deployment: number | null = null) {
  const env = useAppEnv()
  return useQuery<AppLogLine[]>({
    queryKey: [...queryKeys.apps.detail(APPS_SCOPE, appId, env), 'logs', since, deployment],
    queryFn: async () =>
      (
        await appsClient.get<AppLogLine[]>(`/apps/${encodeURIComponent(appId)}/logs`, {
          params: { env, since, limit: 2000, ...(deployment ? { deployment } : {}) },
        })
      ).data,
    refetchInterval: live ? 3000 : false,
    placeholderData: keepPreviousData,
  })
}

/** One deployment's timeline; followed while it runs. */
export function useDeployment(appId: string, number: number) {
  const env = useAppEnv()
  return useQuery<DeploymentDetail>({
    queryKey: [...queryKeys.apps.detail(APPS_SCOPE, appId, env), 'deployment', number],
    queryFn: async () =>
      (
        await appsClient.get<DeploymentDetail>(`/apps/${encodeURIComponent(appId)}/deployments/${number}`, {
          params: { env },
        })
      ).data,
    retry: false,
    refetchInterval: (query) =>
      query.state.data && RELEASE_IN_PROGRESS.includes(query.state.data.status) ? LIVE_MS : false,
  })
}

/** A directory of a volume (files are downloaded, not read into the page). */
export function useVolumeListing(appId: string, volume: string, path: string) {
  const env = useAppEnv()
  return useQuery<VolumeListing>({
    queryKey: [...queryKeys.apps.detail(APPS_SCOPE, appId, env), 'volume', volume, path],
    queryFn: async () =>
      (
        await appsClient.get<VolumeListing>(
          `/apps/${encodeURIComponent(appId)}/volumes/${encodeURIComponent(volume)}/files`,
          { params: { env, path } },
        )
      ).data,
    retry: false,
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

/** The secrets a variable of this App may reference, names only: its own (app/…) and its organization's (org/…). */
export function useAppSecrets(appId: string) {
  return useQuery<{ name: string; updated_at: string }[]>({
    queryKey: [...queryKeys.apps.all, APPS_SCOPE, 'secrets', appId],
    queryFn: async () =>
      (await appsClient.get<{ name: string; updated_at: string }[]>(`/apps/${encodeURIComponent(appId)}/secrets`)).data,
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
