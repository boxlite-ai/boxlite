/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { queryKeys } from '@/hooks/queries/queryKeys'
import { useApi } from '@/hooks/useApi'
import { useConfig } from '@/hooks/useConfig'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import {
  CreateBoxBaseParams,
  CreateBoxFromImageParams,
  CreateBoxFromTemplateParams,
  BoxLite,
  Box,
} from '@boxlite-ai/sdk'
import { QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useAuth } from 'react-oidc-context'
import { toast } from 'sonner'

type CreateBoxParams = CreateBoxBaseParams | CreateBoxFromImageParams | CreateBoxFromTemplateParams

const TERMINAL_PORT = 22222
const VNC_PORT = 6080
const DEFAULT_URL_EXPIRY_SECONDS = 600

export type UseBoxSessionOptions = {
  scope?: string
  createParams?: CreateBoxParams
  terminal?: boolean
  vnc?: boolean
  notify?: { box?: boolean; terminal?: boolean; vnc?: boolean }
  urlExpirySeconds?: number
}

export type BoxState = {
  instance: Box | null
  loading: boolean
  error: string | null
  create: (params?: CreateBoxParams) => Promise<Box>
}

export type PortQueryState = {
  url: string | null
  loading: boolean
  error: string | null
  refetch: () => void
}

export type VncState = PortQueryState & {
  start: () => void
}

export type UseBoxSessionResult = {
  box: BoxState
  terminal: PortQueryState
  vnc: VncState
}

export function removeBoxSessionQueries(queryClient: QueryClient, scope: string): void {
  queryClient
    .getMutationCache()
    .findAll({ mutationKey: ['create-box', scope] })
    .forEach((m) => queryClient.getMutationCache().remove(m))
  queryClient.removeQueries({ queryKey: queryKeys.box.session(scope) })
}

export function removeBoxSessionQueriesByInstanceId(queryClient: QueryClient, boxId: string): void {
  const scopes = new Set<string>()
  for (const query of queryClient.getQueryCache().findAll({ queryKey: queryKeys.box.all })) {
    if (query.queryKey.includes(boxId)) {
      scopes.add(query.queryKey[1] as string)
    }
  }
  scopes.forEach((s) => removeBoxSessionQueries(queryClient, s))
}

export function useBoxSession(options?: UseBoxSessionOptions): UseBoxSessionResult {
  const {
    scope,
    createParams,
    terminal = false,
    vnc = false,
    notify,
    urlExpirySeconds = DEFAULT_URL_EXPIRY_SECONDS,
  } = options ?? {}
  const notifyRef = useRef({ box: true, terminal: true, vnc: true, ...notify })
  notifyRef.current = { box: true, terminal: true, vnc: true, ...notify }
  const { user } = useAuth()
  const { selectedOrganization } = useSelectedOrganization()
  const { boxApi, toolboxApi } = useApi()
  const { apiUrl } = useConfig()
  const queryClient = useQueryClient()

  const client = useMemo(() => {
    if (!user?.access_token || !selectedOrganization?.id) return null
    return new BoxLite({
      jwtToken: user.access_token,
      apiUrl,
      organizationId: selectedOrganization.id,
    })
  }, [apiUrl, user?.access_token, selectedOrganization?.id])

  const createMutation = useMutation<Box, Error, CreateBoxParams | undefined>({
    mutationKey: ['create-box', scope ?? 'default'],
    mutationFn: async (params) => {
      if (!client) throw new Error('Unable to create BoxLite client: missing access token or organization ID.')
      return await client.create(params ?? createParams)
    },
    onSuccess: (newBox) => {
      if (scope) queryClient.setQueryData(queryKeys.box.currentId(scope), newBox.id)
    },
    onError: (error) => {
      if (notifyRef.current.box) {
        toast.error('Failed to create box', {
          description: error.message,
          action: { label: 'Try again', onClick: () => createMutation.mutate(createParams) },
        })
      }
    },
  })

  const persistedBoxId = scope ? queryClient.getQueryData<string>(queryKeys.box.currentId(scope)) : undefined
  const boxId = createMutation.data?.id ?? persistedBoxId ?? ''
  const resolvedScope = scope ?? boxId

  const boxQuery = useQuery<Box>({
    queryKey: queryKeys.box.instance(resolvedScope, boxId),
    queryFn: () => client?.get(boxId) ?? Promise.reject(new Error('Client not initialized')),
    enabled: !!resolvedScope && !!boxId && !!client,
  })

  const box = boxQuery.data ?? createMutation.data ?? null

  const getPortPreviewUrl = useCallback(
    async (id: string, port: number) =>
      (await boxApi.getSignedPortPreviewUrl(id, port, selectedOrganization?.id, urlExpirySeconds)).data.url,
    [boxApi, selectedOrganization?.id, urlExpirySeconds],
  )

  const terminalQuery = useQuery<string, Error>({
    queryKey: queryKeys.box.terminalUrl(resolvedScope, boxId),
    queryFn: () => getPortPreviewUrl(boxId, TERMINAL_PORT),
    enabled: terminal && !!boxId,
    staleTime: Infinity,
  })

  const vncToastId = `vnc-${resolvedScope}-${boxId}`
  const vncToastShownRef = useRef(false)

  const startVncMutation = useMutation<void, Error>({
    mutationFn: async () => {
      await toolboxApi.startComputerUseDeprecated(boxId, selectedOrganization?.id)
    },
    onMutate: () => {
      if (notifyRef.current.vnc) {
        vncToastShownRef.current = true
        toast.loading('Starting VNC desktop...', { id: vncToastId })
      }
    },
    onSuccess: () => {
      if (vncToastShownRef.current) {
        toast.loading('VNC desktop started, checking status...', { id: vncToastId })
      }
    },
  })

  const prevBoxIdRef = useRef<string>('')
  useEffect(() => {
    if (prevBoxIdRef.current && !boxQuery.data && !boxQuery.isFetching) {
      createMutation.reset()
      startVncMutation.reset()
      vncToastShownRef.current = false
      if (scope) removeBoxSessionQueries(queryClient, scope)
    }
    prevBoxIdRef.current = boxId
  }, [boxId, boxQuery.data, boxQuery.isFetching, createMutation, startVncMutation, queryClient, scope])

  const vncStatusQuery = useQuery<string, Error>({
    queryKey: queryKeys.box.vncStatus(resolvedScope, boxId),
    queryFn: async () => {
      const {
        data: { status },
      } = await toolboxApi.getComputerUseStatusDeprecated(boxId, selectedOrganization?.id)
      if (status !== 'active') throw new Error(`VNC desktop not ready: ${status}`)
      return status
    },
    enabled: vnc && !!boxId && startVncMutation.isSuccess,
  })

  const vncReady = vncStatusQuery.data === 'active'

  const vncUrlQuery = useQuery<string, Error>({
    queryKey: queryKeys.box.vncUrl(resolvedScope, boxId),
    queryFn: async () => await getPortPreviewUrl(boxId, VNC_PORT),
    enabled: vnc && !!boxId && vncReady,
    staleTime: Infinity,
  })

  useEffect(() => {
    if (!vncToastShownRef.current) return

    if (vncUrlQuery.data) {
      toast.success('VNC desktop is ready', { id: vncToastId })
      vncToastShownRef.current = false
    } else if (startVncMutation.error) {
      toast.error('Failed to start VNC desktop', { id: vncToastId, description: startVncMutation.error.message })
      vncToastShownRef.current = false
    } else if (vncStatusQuery.error) {
      toast.error('VNC desktop failed to become ready', { id: vncToastId, description: vncStatusQuery.error.message })
      vncToastShownRef.current = false
    }
  }, [vncToastId, vncUrlQuery.data, startVncMutation.error, vncStatusQuery.error])

  const createBox = useCallback(
    (params?: CreateBoxParams) => createMutation.mutateAsync(params ?? createParams),
    [createMutation, createParams],
  )

  return {
    box: {
      instance: box,
      loading: createMutation.isPending || (!!boxId && boxQuery.isLoading),
      error: createMutation.error?.message ?? boxQuery.error?.message ?? null,
      create: createBox,
    },
    terminal: {
      url: terminalQuery.data ?? null,
      loading: terminalQuery.isLoading,
      error: terminalQuery.error?.message ?? null,
      refetch: terminalQuery.refetch,
    },
    vnc: {
      url: vncUrlQuery.data ?? null,
      loading: startVncMutation.isPending || vncStatusQuery.isLoading || (vncReady && vncUrlQuery.isLoading),
      error: startVncMutation.error?.message ?? vncStatusQuery.error?.message ?? vncUrlQuery.error?.message ?? null,
      start: () => startVncMutation.mutate(),
      refetch: () => {
        startVncMutation.reset()
        queryClient.removeQueries({ queryKey: queryKeys.box.vncStatus(resolvedScope, boxId) })
        queryClient.removeQueries({ queryKey: queryKeys.box.vncUrl(resolvedScope, boxId) })
        if (notifyRef.current.vnc) {
          vncToastShownRef.current = true
          toast.loading('Retrying VNC desktop...', { id: vncToastId })
        }
        startVncMutation.mutate()
      },
    },
  }
}
