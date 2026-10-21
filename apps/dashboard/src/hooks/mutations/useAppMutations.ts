/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import type { AppActionInput, AppDetail, AppVisibility, CreateAppInput, UpdateAuthInput } from '@/lib/apps/types'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../queries/queryKeys'
import { useAppEnv } from '../queries/useAppsQuery'

type AppAction =
  | { kind: 'create'; input: CreateAppInput }
  | { kind: 'publish'; appId: string; visibility: AppVisibility }
  | { kind: 'auth'; appId: string; input: UpdateAuthInput }
  | {
      kind: 'domains'
      appId: string
      input: {
        slug?: string
        addDomain?: string
        removeDomain?: string
        verifyDomain?: string
        makePrimary?: string | null
      }
    }
  | { kind: 'restart'; appId: string; service?: string }
  | { kind: 'activate'; appId: string; releaseId: string }
  | { kind: 'sleep'; appId: string }
  | { kind: 'rebuild'; appId: string }
  | { kind: 'rename'; appId: string; name: string }
  | { kind: 'delete'; appId: string }
  | { kind: 'createEnvironment'; appId: string; name: string; from: string | null }
  | { kind: 'deleteEnvironment'; appId: string; name: string }
  | { kind: 'copyVariables'; appId: string; from: string }
  | { kind: 'action'; appId: string; action: AppActionInput }

// Everything below Overview is scoped to the environment in ?env=; the app
// itself (create, rename, delete, its environments) is not.
export function useAppMutation() {
  const api = useApi()
  const queryClient = useQueryClient()
  const { selectedOrganization } = useSelectedOrganization()
  const orgId = selectedOrganization?.id ?? ''
  const env = useAppEnv()

  return useMutation({
    mutationFn: async (action: AppAction): Promise<AppDetail | null> => {
      const client = api.axiosInstance
      const scoped = { params: { env } }
      const base = 'appId' in action ? `/apps/${encodeURIComponent(action.appId)}` : '/apps'
      switch (action.kind) {
        case 'create':
          return (await client.post<AppDetail>('/apps', action.input)).data
        case 'publish':
          return (await client.post<AppDetail>(`${base}/publish`, { visibility: action.visibility }, scoped)).data
        case 'auth':
          return (await client.post<AppDetail>(`${base}/auth`, action.input, scoped)).data
        case 'domains':
          return (await client.post<AppDetail>(`${base}/domains`, action.input, scoped)).data
        case 'restart':
          return (await client.post<AppDetail>(`${base}/restart`, { service: action.service }, scoped)).data
        case 'activate':
          return (
            await client.post<AppDetail>(
              `${base}/releases/${encodeURIComponent(action.releaseId)}/activate`,
              undefined,
              scoped,
            )
          ).data
        case 'sleep':
          return (await client.post<AppDetail>(`${base}/sleep`, undefined, scoped)).data
        case 'rebuild':
          return (await client.post<AppDetail>(`${base}/rebuild`, undefined, scoped)).data
        case 'action':
          return (await client.post<AppDetail>(`${base}/actions`, action.action, scoped)).data
        case 'copyVariables':
          return (await client.post<AppDetail>(`${base}/variables/copy`, { from: action.from }, scoped)).data
        case 'rename':
          return (await client.post<AppDetail>(`${base}/rename`, { name: action.name })).data
        case 'createEnvironment':
          return (await client.post<AppDetail>(`${base}/environments`, { name: action.name, from: action.from })).data
        case 'deleteEnvironment':
          await client.delete(`${base}/environments/${encodeURIComponent(action.name)}`)
          return null
        case 'delete':
          await client.delete(base)
          return null
      }
    },
    onSuccess: (app, action) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.apps.list(orgId) })
      if (app) {
        queryClient.setQueryData(queryKeys.apps.detail(orgId, app.id, app.environment), app)
      }
      if ('appId' in action) {
        // Every environment of the app, and its environment list.
        queryClient.invalidateQueries({ queryKey: queryKeys.apps.detail(orgId, action.appId) })
      }
    },
  })
}

export function useAppSql() {
  const api = useApi()
  const env = useAppEnv()
  return useMutation({
    mutationFn: async ({ appId, query }: { appId: string; query: string }) => {
      const response = await api.axiosInstance.post<{ columns: string[]; rows: (string | number)[][]; total?: number }>(
        `/apps/${appId}/sql`,
        { query },
        { params: { env } },
      )
      return response.data
    },
  })
}
