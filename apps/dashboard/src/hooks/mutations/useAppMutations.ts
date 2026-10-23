/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { rememberPrompt } from '@/lib/apps/handoff'
import { appsClient } from '@/lib/apps/client'
import type {
  AppActionInput,
  AppAuthDetail,
  AppDetail,
  AppVisibility,
  CreateAppInput,
  CreatedApp,
  QueryResult,
} from '@/lib/apps/types'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../queries/queryKeys'
import { APPS_SCOPE, useAppEnv } from '../queries/useAppsQuery'

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
  const queryClient = useQueryClient()
  const env = useAppEnv()

  return useMutation({
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
    onSuccess: (app, action) => {
      // A delete also changes Recently deleted.
      queryClient.invalidateQueries({
        queryKey: action.kind === 'delete' ? queryKeys.apps.all : queryKeys.apps.list(APPS_SCOPE),
      })
      if (app) queryClient.setQueryData(queryKeys.apps.detail(APPS_SCOPE, app.id, app.environment), app)
      // Every environment of the app, its environment list, its database and logs.
      queryClient.invalidateQueries({ queryKey: queryKeys.apps.detail(APPS_SCOPE, action.appId) })
    },
  })
}

/** Creating an App returns its key once; it lives only in the dialog that shows it. */
export function useCreateApp() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: CreateAppInput) => {
      const created = (await appsClient.post<CreatedApp>('/apps', input)).data
      rememberPrompt(created.app.id, created.prompt)
      return created
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.apps.list(APPS_SCOPE) }),
  })
}

/** A new App key and prompt; the old key stops working at once. */
export function useRotateKey() {
  const queryClient = useQueryClient()
  // The prompt names the environment being viewed (other than main), so the agent works there.
  const env = useAppEnv()
  return useMutation({
    mutationFn: async (appId: string) => {
      const out = (
        await appsClient.post<{ key: string; prompt: string; last4: string }>(
          `/apps/${encodeURIComponent(appId)}/key/rotate`,
          undefined,
          { params: { env } },
        )
      ).data
      rememberPrompt(appId, out.prompt)
      return out
    },
    onSuccess: (_data, appId) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apps.detail(APPS_SCOPE, appId) })
      // The active-key list (AppKeys) changes with every issued or rotated key.
      void queryClient.invalidateQueries({ queryKey: [...queryKeys.apps.all, APPS_SCOPE, 'keys', appId] })
    },
  })
}

/** One more App key and its prompt, next to the keys already in use (another agent or machine). */
export function useIssueKey() {
  const queryClient = useQueryClient()
  const env = useAppEnv()
  return useMutation({
    mutationFn: async (appId: string) => {
      const out = (
        await appsClient.post<{ key: string; prompt: string; last4: string }>(
          `/apps/${encodeURIComponent(appId)}/key/issue`,
          undefined,
          { params: { env } },
        )
      ).data
      rememberPrompt(appId, out.prompt)
      return out
    },
    onSuccess: (_data, appId) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apps.detail(APPS_SCOPE, appId) })
      // The active-key list (AppKeys) changes with every issued or rotated key.
      void queryClient.invalidateQueries({ queryKey: [...queryKeys.apps.all, APPS_SCOPE, 'keys', appId] })
    },
  })
}

export function useAppSql() {
  const env = useAppEnv()
  return useMutation({
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
  const queryClient = useQueryClient()
  const env = useAppEnv()
  return useMutation({
    mutationFn: async ({ appId, snapshot }: { appId: string; snapshot: string }) =>
      (
        await appsClient.post<{ restored_to: string; preserved_as: string }>(
          `/apps/${encodeURIComponent(appId)}/database/restore`,
          { snapshot },
          { params: { env } },
        )
      ).data,
    onSuccess: (_d, { appId }) => queryClient.invalidateQueries({ queryKey: queryKeys.apps.detail(APPS_SCOPE, appId) }),
  })
}

/** Sign a user out of, block or unblock them in this environment. */
export function useEndUserAction() {
  const queryClient = useQueryClient()
  const env = useAppEnv()
  return useMutation({
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
    onSuccess: (data, { appId }) =>
      queryClient.setQueryData([...queryKeys.apps.detail(APPS_SCOPE, appId, env), 'auth'], data),
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
  const queryClient = useQueryClient()
  const env = useAppEnv()
  return useMutation({
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
    onSuccess: (data, { appId }) => {
      queryClient.setQueryData([...queryKeys.apps.detail(APPS_SCOPE, appId, env), 'auth'], data)
      // Other environments of the App use the same OAuth app.
      queryClient.invalidateQueries({ queryKey: queryKeys.apps.detail(APPS_SCOPE, appId) })
    },
  })
}

/** Brings a soft-deleted app back (keys work again; Boxes wake on the next request). */
export function useRestoreApp() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (name: string) =>
      (await appsClient.post(`/deleted-apps/${encodeURIComponent(name)}/restore`)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.apps.all }),
  })
}

/** Runs a schedule now, through the app proxy like the scheduler does. */
export function useRunSchedule() {
  const queryClient = useQueryClient()
  const env = useAppEnv()
  return useMutation({
    mutationFn: async ({ appId, name }: { appId: string; name: string }) =>
      (
        await appsClient.post<{ name: string; status: number; ms: number; starting: boolean; app: AppDetail }>(
          `/apps/${encodeURIComponent(appId)}/schedules/${encodeURIComponent(name)}/run`,
          undefined,
          { params: { env } },
        )
      ).data,
    onSuccess: (out, { appId }) => queryClient.setQueryData(queryKeys.apps.detail(APPS_SCOPE, appId, env), out.app),
  })
}

/** Writes one file into a volume (the CLI's `volume cp` route). */
export function useUploadFile() {
  const queryClient = useQueryClient()
  const env = useAppEnv()
  return useMutation({
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
    onSuccess: (_d, { appId, volume }) =>
      queryClient.invalidateQueries({ queryKey: [...queryKeys.apps.detail(APPS_SCOPE, appId, env), 'volume', volume] }),
  })
}

/** Deletes a file, or a folder with everything in it, on a volume. */
export function useDeleteFile() {
  const queryClient = useQueryClient()
  const env = useAppEnv()
  return useMutation({
    mutationFn: async ({ appId, volume, path, folder }: { appId: string; volume: string; path: string; folder: boolean }) =>
      (
        await appsClient.delete<{ volume: string; path: string; removed: 'file' | 'directory' }>(
          `/apps/${encodeURIComponent(appId)}/volumes/${encodeURIComponent(volume)}/files`,
          { params: { env, path, ...(folder ? { recursive: 1 } : {}) } },
        )
      ).data,
    onSuccess: (_d, { appId, volume }) =>
      queryClient.invalidateQueries({ queryKey: [...queryKeys.apps.detail(APPS_SCOPE, appId, env), 'volume', volume] }),
  })
}

/** The App's mail sender for email code sign-in: save (password left out keeps the saved one) or remove. */
export function useEmailSender() {
  const queryClient = useQueryClient()
  const env = useAppEnv()
  const settle = (appId: string, data: AppAuthDetail) => {
    queryClient.setQueryData([...queryKeys.apps.detail(APPS_SCOPE, appId, env), 'auth'], data)
    // Every environment of the App signs in with the same sender.
    queryClient.invalidateQueries({ queryKey: queryKeys.apps.detail(APPS_SCOPE, appId) })
  }
  const save = useMutation({
    mutationFn: async ({ appId, body }: { appId: string; body: { host: string; port: number; username: string | null; password?: string; from: string } }) =>
      (await appsClient.put<AppAuthDetail>(`/apps/${encodeURIComponent(appId)}/auth/email`, body, { params: { env } })).data,
    onSuccess: (data, { appId }) => settle(appId, data),
  })
  const remove = useMutation({
    mutationFn: async ({ appId }: { appId: string }) =>
      (await appsClient.delete<AppAuthDetail>(`/apps/${encodeURIComponent(appId)}/auth/email`, { params: { env } })).data,
    onSuccess: (data, { appId }) => settle(appId, data),
  })
  const test = useMutation({
    mutationFn: async ({ appId, to }: { appId: string; to: string }) =>
      (await appsClient.post<{ sent: boolean; to: string; ms: number }>(`/apps/${encodeURIComponent(appId)}/auth/email/test`, { to }, { params: { env } })).data,
  })
  return { save, remove, test }
}
