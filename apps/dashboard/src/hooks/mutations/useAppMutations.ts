/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useAppsScope } from '@/lib/apps/client'
import type {
  AppActionInput,
  AppAuthDetail,
  AppDomain,
  AppDetail,
  AppVisibility,
  CreateAppInput,
  CreatedApp,
  QueryResult,
} from '@/lib/apps/types'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../queries/queryKeys'
import { useAppEnv } from '../queries/useAppsQuery'

type AppAction =
  | { kind: 'publish'; appId: string; visibility: AppVisibility }
  | { kind: 'restart'; appId: string; service?: string }
  | { kind: 'activate'; appId: string; releaseId: string }
  | { kind: 'sleep'; appId: string }
  | { kind: 'delete'; appId: string }
  | { kind: 'createEnvironment'; appId: string; name: string; from: string | null; withData: boolean }
  | { kind: 'deleteEnvironment'; appId: string; name: string }
  | { kind: 'copyVariables'; appId: string; from: string }
  | { kind: 'action'; appId: string; action: AppActionInput }

// Everything below Overview is scoped to the environment in ?env=; the app
// itself (create, delete, its environments, its key) is not. Every change goes
// to the control plane; the ones that change configuration start a deployment.
export function useAppMutation() {
  const { client: appsClient, organizationId, canWrite, canDelete } = useAppsScope()
  const queryClient = useQueryClient()
  const env = useAppEnv()

  return useMutation({
    onMutate: (action) => {
      const allowed = action.kind === 'delete' || action.kind === 'deleteEnvironment' ? canDelete : canWrite
      if (!allowed) throw new Error('You do not have permission to change this App')
      return { organizationId, env }
    },
    mutationFn: async (action: AppAction): Promise<AppDetail | null> => {
      const scoped = { params: { env } }
      const base = `/apps/${encodeURIComponent(action.appId)}`
      switch (action.kind) {
        case 'publish':
          return (await appsClient.post<AppDetail>(`${base}/publish`, { visibility: action.visibility }, scoped)).data
        case 'restart':
          return (await appsClient.post<AppDetail>(`${base}/restart`, { service: action.service }, scoped)).data
        case 'activate':
          return (
            await appsClient.post<AppDetail>(
              `${base}/releases/${encodeURIComponent(action.releaseId)}/activate`,
              undefined,
              scoped,
            )
          ).data
        case 'sleep':
          return (await appsClient.post<AppDetail>(`${base}/sleep`, undefined, scoped)).data
        case 'action':
          return (await appsClient.post<AppDetail>(`${base}/actions`, action.action, scoped)).data
        case 'copyVariables':
          return (await appsClient.post<AppDetail>(`${base}/variables/copy`, { from: action.from }, scoped)).data
        case 'createEnvironment':
          await appsClient.post(`${base}/environments`, {
            name: action.name,
            from: action.from,
            withData: action.withData,
          })
          return null
        case 'deleteEnvironment':
          await appsClient.delete(`${base}/environments/${encodeURIComponent(action.name)}`)
          return null
        case 'delete':
          await appsClient.delete(base)
          return null
      }
    },
    onSuccess: (app, action, scope) => {
      const organizationId = scope.organizationId
      // A delete also changes Recently deleted.
      queryClient.invalidateQueries({
        queryKey:
          action.kind === 'delete' ? queryKeys.apps.organization(organizationId) : queryKeys.apps.list(organizationId),
      })
      if (app) queryClient.setQueryData(queryKeys.apps.detail(organizationId, app.id, app.environment), app)
      // Every environment of the app, its environment list, its database and logs.
      queryClient.invalidateQueries({ queryKey: queryKeys.apps.detail(organizationId, action.appId) })
    },
  })
}

export function useCreateApp() {
  const { client: appsClient, organizationId, canWrite } = useAppsScope()
  const queryClient = useQueryClient()
  return useMutation({
    onMutate: () => {
      if (!canWrite) throw new Error('You do not have permission to change this App')
      return { organizationId }
    },
    mutationFn: async (input: CreateAppInput) => (await appsClient.post<CreatedApp>('/apps', input)).data,
    onSuccess: (_data, _input, scope) =>
      queryClient.invalidateQueries({ queryKey: queryKeys.apps.list(scope.organizationId) }),
  })
}

export function useAppSql() {
  const { client: appsClient, organizationId, canWrite } = useAppsScope()
  const env = useAppEnv()
  return useMutation({
    onMutate: ({ write }) => {
      if (write && !canWrite) throw new Error('You need App write permission to change data')
      return { organizationId, env }
    },
    mutationFn: async ({
      appId,
      query,
      write,
      explain,
    }: {
      appId: string
      query: string
      write?: boolean
      explain?: boolean
    }) =>
      (
        await appsClient.post<QueryResult>(
          `/apps/${encodeURIComponent(appId)}/sql`,
          { query, write, explain },
          { params: { env } },
        )
      ).data,
  })
}

export function useRestoreDatabase() {
  const { client: appsClient, organizationId, canWrite } = useAppsScope()
  const queryClient = useQueryClient()
  const env = useAppEnv()
  return useMutation({
    onMutate: () => {
      if (!canWrite) throw new Error('You do not have permission to change this App')
      return { organizationId, env }
    },
    mutationFn: async ({ appId, snapshot }: { appId: string; snapshot: string }) =>
      (
        await appsClient.post<{ restored_to: string; preserved_as: string }>(
          `/apps/${encodeURIComponent(appId)}/database/restore`,
          { snapshot },
          { params: { env } },
        )
      ).data,
    onSuccess: (_d, { appId }, scope) =>
      queryClient.invalidateQueries({ queryKey: queryKeys.apps.detail(scope.organizationId, appId) }),
  })
}

/** Sign a user out of, block or unblock them in this environment. */
export function useEndUserAction() {
  const { client: appsClient, organizationId, canWrite } = useAppsScope()
  const queryClient = useQueryClient()
  const env = useAppEnv()
  return useMutation({
    onMutate: () => {
      if (!canWrite) throw new Error('You do not have permission to change this App')
      return { organizationId, env }
    },
    mutationFn: async ({
      appId,
      userId,
      op,
    }: {
      appId: string
      userId: string
      op: 'sign-out' | 'block' | 'unblock'
    }) =>
      (
        await appsClient.post<AppAuthDetail>(
          `/apps/${encodeURIComponent(appId)}/users/${encodeURIComponent(userId)}/${op}`,
          undefined,
          { params: { env } },
        )
      ).data,
    onSuccess: (data, { appId }, scope) =>
      queryClient.setQueryData([...queryKeys.apps.detail(scope.organizationId, appId, scope.env), 'auth'], data),
  })
}

/** The App's own OAuth app; Apple's secret is its .p8 key with the Team ID and Key ID. Left-out secrets keep the saved ones. */
export type OwnOAuthClient = {
  keys: 'own'
  clientId: string
  clientSecret?: string
  teamId?: string
  keyId?: string
  privateKey?: string
}

/** Whose OAuth app signs users in for one provider: BoxLite's, or the App's own (all environments). */
export function useSetOAuthClient() {
  const { client: appsClient, organizationId, canWrite } = useAppsScope()
  const queryClient = useQueryClient()
  const env = useAppEnv()
  return useMutation({
    onMutate: () => {
      if (!canWrite) throw new Error('You do not have permission to change this App')
      return { organizationId, env }
    },
    mutationFn: async ({
      appId,
      provider,
      body,
    }: {
      appId: string
      provider: string
      body: { keys: 'shared' } | OwnOAuthClient
    }) =>
      (
        await appsClient.put<AppAuthDetail>(
          `/apps/${encodeURIComponent(appId)}/auth/methods/${encodeURIComponent(provider)}`,
          body,
          { params: { env } },
        )
      ).data,
    onSuccess: (data, { appId }, scope) => {
      const organizationId = scope.organizationId
      queryClient.setQueryData([...queryKeys.apps.detail(organizationId, appId, env), 'auth'], data)
      // Other environments of the App use the same OAuth app.
      queryClient.invalidateQueries({ queryKey: queryKeys.apps.detail(organizationId, appId) })
    },
  })
}

/** Brings a soft-deleted app back (keys work again; Boxes wake on the next request). */
export function useRestoreApp() {
  const { client: appsClient, organizationId, canDelete } = useAppsScope()
  const queryClient = useQueryClient()
  return useMutation({
    onMutate: () => {
      if (!canDelete) throw new Error('You do not have permission to change this App')
      return { organizationId }
    },
    mutationFn: async (name: string) =>
      (await appsClient.post(`/apps/deleted/${encodeURIComponent(name)}/restore`)).data,
    onSuccess: (_data, _input, scope) =>
      queryClient.invalidateQueries({ queryKey: queryKeys.apps.organization(scope.organizationId) }),
  })
}

/** Runs a schedule now, through the app proxy like the scheduler does. */
export function useRunSchedule() {
  const { client: appsClient, organizationId, canWrite } = useAppsScope()
  const queryClient = useQueryClient()
  const env = useAppEnv()
  return useMutation({
    onMutate: () => {
      if (!canWrite) throw new Error('You do not have permission to change this App')
      return { organizationId, env }
    },
    mutationFn: async ({ appId, name }: { appId: string; name: string }) =>
      (
        await appsClient.post<{ name: string; status: number; ms: number; starting: boolean; app: AppDetail }>(
          `/apps/${encodeURIComponent(appId)}/schedules/${encodeURIComponent(name)}/run`,
          undefined,
          { params: { env } },
        )
      ).data,
    onSuccess: (out, { appId }, scope) =>
      queryClient.setQueryData(queryKeys.apps.detail(scope.organizationId, appId, scope.env), out.app),
  })
}

/** Writes one file into a volume (the CLI's `volume cp` route). */
export function useUploadFile() {
  const { client: appsClient, organizationId, canWrite } = useAppsScope()
  const queryClient = useQueryClient()
  const env = useAppEnv()
  return useMutation({
    onMutate: () => {
      if (!canWrite) throw new Error('You do not have permission to change this App')
      return { organizationId, env }
    },
    mutationFn: async ({
      appId,
      volume,
      path,
      file,
      overwrite,
    }: {
      appId: string
      volume: string
      path: string
      file: File
      overwrite: boolean
    }) =>
      (
        await appsClient.put<{ volume: string; path: string; bytes: number; replaced: boolean }>(
          `/apps/${encodeURIComponent(appId)}/volumes/${encodeURIComponent(volume)}/files`,
          await file.arrayBuffer(),
          {
            params: { env, path, ...(overwrite ? { overwrite: 1 } : {}) },
            headers: { 'content-type': 'application/octet-stream' },
          },
        )
      ).data,
    onSuccess: (_d, { appId, volume }, scope) =>
      queryClient.invalidateQueries({
        queryKey: [...queryKeys.apps.detail(scope.organizationId, appId, scope.env), 'volume', volume],
      }),
  })
}

/** Deletes a file, or a folder with everything in it, on a volume. */
export function useDeleteFile() {
  const { client: appsClient, organizationId, canWrite } = useAppsScope()
  const queryClient = useQueryClient()
  const env = useAppEnv()
  return useMutation({
    onMutate: () => {
      if (!canWrite) throw new Error('You do not have permission to change this App')
      return { organizationId, env }
    },
    mutationFn: async ({
      appId,
      volume,
      path,
      folder,
    }: {
      appId: string
      volume: string
      path: string
      folder: boolean
    }) =>
      (
        await appsClient.delete<{ volume: string; path: string; removed: 'file' | 'directory' }>(
          `/apps/${encodeURIComponent(appId)}/volumes/${encodeURIComponent(volume)}/files`,
          { params: { env, path, ...(folder ? { recursive: 1 } : {}) } },
        )
      ).data,
    onSuccess: (_d, { appId, volume }, scope) =>
      queryClient.invalidateQueries({
        queryKey: [...queryKeys.apps.detail(scope.organizationId, appId, scope.env), 'volume', volume],
      }),
  })
}

/** The App's mail sender for email code sign-in: save (password left out keeps the saved one) or remove. */
export function useEmailSender() {
  const { client: appsClient, organizationId, canWrite } = useAppsScope()
  const queryClient = useQueryClient()
  const env = useAppEnv()
  const settle = (appId: string, data: AppAuthDetail, organizationId: string, env: string) => {
    queryClient.setQueryData([...queryKeys.apps.detail(organizationId, appId, env), 'auth'], data)
    // Every environment of the App signs in with the same sender.
    queryClient.invalidateQueries({ queryKey: queryKeys.apps.detail(organizationId, appId) })
  }
  const save = useMutation({
    onMutate: () => {
      if (!canWrite) throw new Error('You do not have permission to change this App')
      return { organizationId, env }
    },
    mutationFn: async ({
      appId,
      body,
    }: {
      appId: string
      body: { host: string; port: number; username: string | null; password?: string; from: string }
    }) =>
      (await appsClient.put<AppAuthDetail>(`/apps/${encodeURIComponent(appId)}/auth/email`, body, { params: { env } }))
        .data,
    onSuccess: (data, { appId }, scope) => settle(appId, data, scope.organizationId, scope.env),
  })
  const remove = useMutation({
    onMutate: () => {
      if (!canWrite) throw new Error('You do not have permission to change this App')
      return { organizationId, env }
    },
    mutationFn: async ({ appId }: { appId: string }) =>
      (await appsClient.delete<AppAuthDetail>(`/apps/${encodeURIComponent(appId)}/auth/email`, { params: { env } }))
        .data,
    onSuccess: (data, { appId }, scope) => settle(appId, data, scope.organizationId, scope.env),
  })
  const test = useMutation({
    onMutate: () => {
      if (!canWrite) throw new Error('You do not have permission to change this App')
      return { organizationId, env }
    },
    mutationFn: async ({ appId, to }: { appId: string; to: string }) =>
      (
        await appsClient.post<{ sent: boolean; to: string; ms: number }>(
          `/apps/${encodeURIComponent(appId)}/auth/email/test`,
          { to },
          { params: { env } },
        )
      ).data,
  })
  return { save, remove, test }
}

/** An environment's custom domains: add (returns the DNS records), verify, remove. */
export function useDomains() {
  const { client: appsClient, organizationId, canWrite } = useAppsScope()
  const queryClient = useQueryClient()
  const env = useAppEnv()
  const refresh = (appId: string, organizationId: string, env: string) =>
    queryClient.invalidateQueries({ queryKey: queryKeys.apps.detail(organizationId, appId, env) })
  const path = (appId: string, host?: string) =>
    `/apps/${encodeURIComponent(appId)}/domains${host ? `/${encodeURIComponent(host)}` : ''}`
  const add = useMutation({
    onMutate: () => {
      if (!canWrite) throw new Error('You do not have permission to change this App')
      return { organizationId, env }
    },
    mutationFn: async ({ appId, host }: { appId: string; host: string }) =>
      (await appsClient.post<AppDomain>(path(appId), { host }, { params: { env } })).data,
    onSuccess: (_d, { appId }, scope) => refresh(appId, scope.organizationId, scope.env),
  })
  const remove = useMutation({
    onMutate: () => {
      if (!canWrite) throw new Error('You do not have permission to change this App')
      return { organizationId, env }
    },
    mutationFn: async ({ appId, host }: { appId: string; host: string }) =>
      (await appsClient.delete<{ removed: string }>(path(appId, host), { params: { env } })).data,
    onSuccess: (_d, { appId }, scope) => refresh(appId, scope.organizationId, scope.env),
  })
  return { add, remove }
}
