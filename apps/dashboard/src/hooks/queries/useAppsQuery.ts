/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useAppsScope } from '@/lib/apps/client'
import {
  RELEASE_IN_PROGRESS,
  type AppAuthDetail,
  type AppDatabaseDetail,
  type AppDetail,
  type AppLogLine,
  type AppSummary,
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

export const isBusy = (app: AppDetail | undefined) =>
  !!app && (app.status === 'building' || app.releases.some((r) => RELEASE_IN_PROGRESS.includes(r.status)))

/** How often a busy environment is re-read: the header and Deployments row follow a deploy within this. */
const LIVE_MS = 1500

export function useAppsQuery() {
  const { client: appsClient, organizationId, canRead } = useAppsScope()
  return useQuery<AppSummary[]>({
    queryKey: queryKeys.apps.list(organizationId),
    enabled: !!organizationId && canRead,
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
  const { client: appsClient, organizationId, canRead } = useAppsScope()
  const env = useAppEnv()
  return useQuery<AppDetail>({
    queryKey: queryKeys.apps.detail(organizationId, appId, env),
    queryFn: async () =>
      (await appsClient.get<AppDetail>(`/apps/${encodeURIComponent(appId)}/view`, { params: { env } })).data,
    enabled: !!appId && !!organizationId && canRead,
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
  const { organizationId } = useAppsScope()
  const queryClient = useQueryClient()
  const wasBusy = useRef(false)
  const busyNow = isBusy(app)
  useEffect(() => {
    if (wasBusy.current && !busyNow && app) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apps.detail(organizationId, app.id) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.apps.list(organizationId) })
    }
    wasBusy.current = busyNow
  }, [busyNow, app, queryClient, organizationId])
}

/** Soft-deleted apps, restorable until their purge date. */
export function useDeletedApps() {
  const { client: appsClient, organizationId, canRead } = useAppsScope()
  return useQuery<DeletedApp[]>({
    queryKey: [...queryKeys.apps.all, organizationId, 'deleted'],
    enabled: !!organizationId && canRead,
    queryFn: async () => (await appsClient.get<DeletedApp[]>('/apps/deleted')).data,
    refetchInterval: 30_000,
  })
}

export function useAppEnvironments(appId: string) {
  const { client: appsClient, organizationId, canRead } = useAppsScope()
  return useQuery<EnvironmentSummary[]>({
    queryKey: queryKeys.apps.environments(organizationId, appId),
    queryFn: async () =>
      (await appsClient.get<EnvironmentSummary[]>(`/apps/${encodeURIComponent(appId)}/environments`)).data,
    enabled: !!appId && !!organizationId && canRead,
  })
}

export function useAppLogs(appId: string, since: string, live: boolean, deployment: number | null = null) {
  const { client: appsClient, organizationId, canRead } = useAppsScope()
  const env = useAppEnv()
  return useQuery<AppLogLine[]>({
    queryKey: [...queryKeys.apps.detail(organizationId, appId, env), 'logs', since, deployment],
    enabled: !!organizationId && canRead,
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
  const { client: appsClient, organizationId, canRead } = useAppsScope()
  const env = useAppEnv()
  return useQuery<DeploymentDetail>({
    queryKey: [...queryKeys.apps.detail(organizationId, appId, env), 'deployment', number],
    enabled: !!organizationId && canRead,
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
  const { client: appsClient, organizationId, canRead } = useAppsScope()
  const env = useAppEnv()
  return useQuery<VolumeListing>({
    queryKey: [...queryKeys.apps.detail(organizationId, appId, env), 'volume', volume, path],
    enabled: !!organizationId && canRead,
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
  const { client: appsClient, organizationId, canRead } = useAppsScope()
  const env = useAppEnv()
  return useQuery<AppDatabaseDetail>({
    queryKey: [...queryKeys.apps.detail(organizationId, appId, env), 'database'],
    queryFn: async () =>
      (await appsClient.get<AppDatabaseDetail>(`/apps/${encodeURIComponent(appId)}/database`, { params: { env } }))
        .data,
    enabled: enabled && !!organizationId && canRead,
    retry: false,
  })
}

export function useTableRows(appId: string, table: string, search: string, limit: number, offset: number) {
  const { client: appsClient, organizationId, canRead } = useAppsScope()
  const env = useAppEnv()
  return useQuery<QueryResult>({
    queryKey: [...queryKeys.apps.detail(organizationId, appId, env), 'rows', table, search, limit, offset],
    enabled: !!organizationId && canRead,
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
  const { client: appsClient, organizationId, canRead } = useAppsScope()
  return useQuery<{ name: string; updated_at: string }[]>({
    queryKey: [...queryKeys.apps.all, organizationId, 'secrets', appId],
    enabled: !!organizationId && canRead,
    queryFn: async () =>
      (await appsClient.get<{ name: string; updated_at: string }[]>(`/apps/${encodeURIComponent(appId)}/secrets`)).data,
  })
}

export function useAppAuth(appId: string) {
  const { client: appsClient, organizationId, canRead } = useAppsScope()
  const env = useAppEnv()
  return useQuery<AppAuthDetail>({
    queryKey: [...queryKeys.apps.detail(organizationId, appId, env), 'auth'],
    enabled: !!organizationId && canRead,
    queryFn: async () =>
      (await appsClient.get<AppAuthDetail>(`/apps/${encodeURIComponent(appId)}/auth`, { params: { env } })).data,
  })
}
