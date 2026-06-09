/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationSuspendedError } from '@/api/errors'
import { OnboardingGuideDialog } from '@/components/OnboardingGuideDialog'
import { PageContent, PageLayout } from '@/components/PageLayout'
import { CreateSandboxSheet } from '@/components/Sandbox/CreateSandboxSheet'
import { SandboxTable } from '@/components/SandboxTable'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { DEFAULT_PAGE_SIZE } from '@/constants/Pagination'
import { LocalStorageKey } from '@/enums/LocalStorageKey'
import { RoutePath } from '@/enums/RoutePath'
import { useTemplatesQuery } from '@/hooks/queries/useTemplatesQuery'
import { CopyableValue } from '@/components/ui/copyable-value'
import { useApi } from '@/hooks/useApi'
import { useConfig } from '@/hooks/useConfig'
import { useNotificationSocket } from '@/hooks/useNotificationSocket'
import { useRegions } from '@/hooks/useRegions'
import {
  DEFAULT_SANDBOX_SORTING,
  getSandboxesQueryKey,
  SandboxFilters,
  SandboxQueryParams,
  SandboxSorting,
  useSandboxes,
} from '@/hooks/useSandboxes'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { createBulkActionToast } from '@/lib/bulk-action-toast'
import { handleApiError } from '@/lib/error-handling'
import { getLocalStorageItem, setLocalStorageItem } from '@/lib/local-storage'
import {
  ONBOARDING_ENTRY_HIGHLIGHT_EVENT,
  ONBOARDING_OPEN_EVENT,
  mergeOnboardingProgress,
  ONBOARDING_PROGRESS_EVENT,
  readOnboardingProgress,
  type OnboardingProgress,
} from '@/lib/onboarding-progress'
import { getSandboxRouteId } from '@/lib/sandbox-identity'
import { formatDuration, pluralize } from '@/lib/utils'
import {
  OrganizationRolePermissionsEnum,
  OrganizationUserRoleEnum,
  Sandbox,
  SandboxDesiredState,
  SandboxState,
  SshAccessDto,
} from '@boxlite-ai/api-client'
import { QueryKey, useQueryClient } from '@tanstack/react-query'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { generatePath, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

interface SandboxesLocationState {
  openCreateBox?: boolean
}

const Sandboxes: React.FC = () => {
  const { sandboxApi } = useApi()
  const { user } = useAuth()
  const userId = user?.profile.sub
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const { notificationSocket } = useNotificationSocket()
  const config = useConfig()
  const queryClient = useQueryClient()
  const { selectedOrganization, authenticatedUserOrganizationMember, authenticatedUserHasPermission } =
    useSelectedOrganization()
  const [createSandboxOpen, setCreateSandboxOpen] = useState(false)
  const [showOnboardingDialog, setShowOnboardingDialog] = useState(false)
  const [onboardingProgress, setOnboardingProgress] = useState<OnboardingProgress>(() => readOnboardingProgress(userId))

  const updateOnboardingProgress = useCallback(
    (progress: OnboardingProgress) => {
      setOnboardingProgress(mergeOnboardingProgress(userId, progress))
    },
    [userId],
  )

  useEffect(() => {
    setOnboardingProgress(readOnboardingProgress(userId))
  }, [userId])

  useEffect(() => {
    const handleOnboardingProgress = (event: Event) => {
      const progress = (event as CustomEvent<OnboardingProgress>).detail
      setOnboardingProgress(progress ?? readOnboardingProgress(userId))
    }

    window.addEventListener(ONBOARDING_PROGRESS_EVENT, handleOnboardingProgress)
    return () => window.removeEventListener(ONBOARDING_PROGRESS_EVENT, handleOnboardingProgress)
  }, [userId])

  // Pagination

  const [paginationParams, setPaginationParams] = useState({
    pageIndex: 0,
    pageSize: DEFAULT_PAGE_SIZE,
  })

  const handlePaginationChange = useCallback(({ pageIndex, pageSize }: { pageIndex: number; pageSize: number }) => {
    setPaginationParams({ pageIndex, pageSize })
  }, [])

  // Filters

  const [filters, setFilters] = useState<SandboxFilters>({})

  const handleFiltersChange = useCallback((filters: SandboxFilters) => {
    setFilters(filters)
    setPaginationParams((prev) => ({ ...prev, pageIndex: 0 }))
  }, [])

  // Sorting

  const [sorting, setSorting] = useState<SandboxSorting>(DEFAULT_SANDBOX_SORTING)

  const handleSortingChange = useCallback((sorting: SandboxSorting) => {
    setSorting(sorting)
    setPaginationParams((prev) => ({ ...prev, pageIndex: 0 }))
  }, [])

  // Sandboxes Data

  const queryParams = useMemo<SandboxQueryParams>(
    () => ({
      page: paginationParams.pageIndex + 1, // 1-indexed
      pageSize: paginationParams.pageSize,
      filters: filters,
      sorting: sorting,
    }),
    [paginationParams, filters, sorting],
  )

  const baseQueryKey = useMemo<QueryKey>(
    () => getSandboxesQueryKey(selectedOrganization?.id),
    [selectedOrganization?.id],
  )

  const queryKey = useMemo<QueryKey>(
    () => getSandboxesQueryKey(selectedOrganization?.id, queryParams),
    [selectedOrganization?.id, queryParams],
  )

  const {
    data: sandboxesData,
    isLoading: sandboxesDataIsLoading,
    error: sandboxesDataError,
    refetch: refetchSandboxesData,
  } = useSandboxes(queryKey, queryParams)
  const hasBoxes = (sandboxesData?.items.length ?? 0) > 0 || (sandboxesData?.total ?? 0) > 0

  useEffect(() => {
    if (sandboxesDataError) {
      handleApiError(sandboxesDataError, 'Failed to fetch boxes')
    }
  }, [sandboxesDataError])

  const updateSandboxInCache = useCallback(
    (sandboxId: string, updates: Partial<Sandbox>) => {
      queryClient.setQueryData(queryKey, (oldData: any) => {
        if (!oldData?.items) return oldData
        return {
          ...oldData,
          items: oldData.items.map((sandbox: Sandbox) =>
            sandbox.id === sandboxId ? { ...sandbox, ...updates } : sandbox,
          ),
        }
      })
    },
    [queryClient, queryKey],
  )

  const removeSandboxFromCache = useCallback(
    (sandboxId: string) => {
      queryClient.setQueryData(queryKey, (oldData: any) => {
        if (!oldData?.items) return oldData
        const nextItems = oldData.items.filter((sandbox: Sandbox) => sandbox.id !== sandboxId)
        return {
          ...oldData,
          items: nextItems,
          total: Math.max((oldData.total ?? nextItems.length) - 1, nextItems.length),
        }
      })
    },
    [queryClient, queryKey],
  )

  /**
   * Marks all sandbox queries for this organization as stale.
   *
   * Useful when sandbox event occurs and we don't have a good way of knowing for which combination of query parameters the sandbox would be shown.
   *
   * @param shouldRefetchActiveQueries If true, only active queries will be refetched. Otherwise, no queries will be refetched.
   */
  const markAllSandboxQueriesAsStale = useCallback(
    async (shouldRefetchActiveQueries = false) => {
      queryClient.invalidateQueries({
        queryKey: baseQueryKey,
        refetchType: shouldRefetchActiveQueries ? 'active' : 'none',
      })
    },
    [queryClient, baseQueryKey],
  )

  /**
   * Aborts all outgoing refetches for the provided key.
   *
   * Useful for preventing refetches from overwriting optimistic updates.
   *
   * @param queryKey
   */
  const cancelQueryRefetches = useCallback(
    async (queryKey: QueryKey) => {
      queryClient.cancelQueries({ queryKey })
    },
    [queryClient],
  )

  // Go to previous page if there are no items on the current page

  useEffect(() => {
    if (sandboxesData?.items.length === 0 && paginationParams.pageIndex > 0) {
      setPaginationParams((prev) => ({
        ...prev,
        pageIndex: prev.pageIndex - 1,
      }))
    }
  }, [sandboxesData?.items.length, paginationParams.pageIndex])

  // Ephemeral Sandbox States

  const [sandboxIsLoading, setSandboxIsLoading] = useState<Record<string, boolean>>({})
  const [sandboxStateIsTransitioning, setSandboxStateIsTransitioning] = useState<Record<string, boolean>>({}) // display transition animation

  // Manual Refreshing

  const [sandboxDataIsRefreshing, setSandboxDataIsRefreshing] = useState(false)

  const handleRefresh = useCallback(async () => {
    setSandboxDataIsRefreshing(true)
    try {
      await refetchSandboxesData()
    } catch (error) {
      handleApiError(error, 'Failed to refresh boxes')
    } finally {
      setSandboxDataIsRefreshing(false)
    }
  }, [refetchSandboxesData])

  // Delete Sandbox Dialog

  const [sandboxToDelete, setSandboxToDelete] = useState<string | null>(null)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)

  const performSandboxStateOptimisticUpdate = useCallback(
    (sandboxId: string, newState: SandboxState) => {
      updateSandboxInCache(sandboxId, { state: newState })
    },
    [updateSandboxInCache],
  )

  const revertSandboxStateOptimisticUpdate = useCallback(
    (sandboxId: string, previousState?: SandboxState) => {
      if (!previousState) {
        return
      }

      updateSandboxInCache(sandboxId, { state: previousState })
    },
    [updateSandboxInCache],
  )

  // SSH Access Dialogs

  const [showCreateSshDialog, setShowCreateSshDialog] = useState(false)
  const [showRevokeSshDialog, setShowRevokeSshDialog] = useState(false)
  const [sshAccess, setSshAccess] = useState<SshAccessDto | null>(null)
  const [sshExpiryMinutes, setSshExpiryMinutes] = useState<number>(60)
  const [revokeSshToken, setRevokeSshToken] = useState<string>('')
  const [sshSandboxId, setSshSandboxId] = useState<string>('')
  const [copied, setCopied] = useState<string | null>(null)

  const { data: templatesData, isLoading: templatesDataIsLoading, error: templatesDataError } = useTemplatesQuery()

  useEffect(() => {
    if (templatesDataError) {
      handleApiError(templatesDataError, 'Failed to fetch images')
    }
  }, [templatesDataError])

  const { getRegionName } = useRegions()

  // Subscribe to Sandbox Events

  useEffect(() => {
    const handleSandboxCreatedEvent = () => {
      updateOnboardingProgress({ boxCreated: true })

      const isFirstPage = paginationParams.pageIndex === 0
      const isDefaultFilters = Object.keys(filters).length === 0
      const isDefaultSorting =
        sorting.field === DEFAULT_SANDBOX_SORTING.field && sorting.direction === DEFAULT_SANDBOX_SORTING.direction

      const shouldRefetchActiveQueries = isFirstPage && isDefaultFilters && isDefaultSorting

      markAllSandboxQueriesAsStale(shouldRefetchActiveQueries)
    }

    const handleSandboxStateUpdatedEvent = (data: {
      sandbox: Sandbox
      oldState: SandboxState
      newState: SandboxState
    }) => {
      // warm pool sandboxes
      if (data.oldState === data.newState && data.newState === SandboxState.STARTED) {
        handleSandboxCreatedEvent()
        return
      }

      let updatedState = data.newState

      // error,build_failed | destroyed should be displayed as destroyed in the UI
      if (
        data.sandbox.desiredState === SandboxDesiredState.DESTROYED &&
        (data.newState === SandboxState.ERROR || data.newState === SandboxState.BUILD_FAILED)
      ) {
        updatedState = SandboxState.DESTROYED
      }

      if (updatedState === SandboxState.DESTROYED) {
        removeSandboxFromCache(data.sandbox.id)
      } else {
        performSandboxStateOptimisticUpdate(data.sandbox.id, updatedState)
      }

      markAllSandboxQueriesAsStale()
    }

    const handleSandboxDesiredStateUpdatedEvent = (data: {
      sandbox: Sandbox
      oldDesiredState: SandboxDesiredState
      newDesiredState: SandboxDesiredState
    }) => {
      // error,build_failed | destroyed should be displayed as destroyed in the UI

      if (data.newDesiredState !== SandboxDesiredState.DESTROYED) {
        return
      }

      if (data.sandbox.state !== SandboxState.ERROR && data.sandbox.state !== SandboxState.BUILD_FAILED) {
        return
      }

      removeSandboxFromCache(data.sandbox.id)

      markAllSandboxQueriesAsStale()
    }

    if (!notificationSocket) {
      return
    }

    notificationSocket.on('sandbox.created', handleSandboxCreatedEvent)
    notificationSocket.on('sandbox.state.updated', handleSandboxStateUpdatedEvent)
    notificationSocket.on('sandbox.desired-state.updated', handleSandboxDesiredStateUpdatedEvent)

    return () => {
      notificationSocket.off('sandbox.created', handleSandboxCreatedEvent)
      notificationSocket.off('sandbox.state.updated', handleSandboxStateUpdatedEvent)
      notificationSocket.off('sandbox.desired-state.updated', handleSandboxDesiredStateUpdatedEvent)
    }
  }, [
    filters,
    markAllSandboxQueriesAsStale,
    notificationSocket,
    paginationParams.pageIndex,
    performSandboxStateOptimisticUpdate,
    removeSandboxFromCache,
    sorting.direction,
    sorting.field,
    updateOnboardingProgress,
  ])

  useEffect(() => {
    if (hasBoxes && !onboardingProgress.boxCreated) {
      updateOnboardingProgress({ boxCreated: true })
    }
  }, [hasBoxes, onboardingProgress.boxCreated, updateOnboardingProgress])

  // Sandbox Action Handlers

  const handleStart = async (id: string) => {
    setSandboxIsLoading((prev) => ({ ...prev, [id]: true }))
    setSandboxStateIsTransitioning((prev) => ({ ...prev, [id]: true }))

    const sandboxToStart = sandboxesData?.items.find((s) => s.id === id)
    const previousState = sandboxToStart?.state

    await cancelQueryRefetches(queryKey)
    performSandboxStateOptimisticUpdate(id, SandboxState.STARTING)

    try {
      await sandboxApi.startSandbox(id, selectedOrganization?.id)
      toast.success(`Starting box with ID: ${id}`)
      await markAllSandboxQueriesAsStale()
    } catch (error) {
      handleApiError(error, 'Failed to start box', {
        action:
          error instanceof OrganizationSuspendedError &&
          config.billingApiUrl &&
          authenticatedUserOrganizationMember?.role === OrganizationUserRoleEnum.OWNER ? (
            <Button variant="secondary" onClick={() => navigate(RoutePath.BILLING_WALLET)}>
              Go to billing
            </Button>
          ) : undefined,
      })
      revertSandboxStateOptimisticUpdate(id, previousState)
    } finally {
      setSandboxIsLoading((prev) => ({ ...prev, [id]: false }))
      setTimeout(() => {
        setSandboxStateIsTransitioning((prev) => ({ ...prev, [id]: false }))
      }, 2000)
    }
  }

  const handleRecover = async (id: string) => {
    setSandboxIsLoading((prev) => ({ ...prev, [id]: true }))
    setSandboxStateIsTransitioning((prev) => ({ ...prev, [id]: true }))

    const sandboxToRecover = sandboxesData?.items.find((s) => s.id === id)
    const previousState = sandboxToRecover?.state

    await cancelQueryRefetches(queryKey)
    performSandboxStateOptimisticUpdate(id, SandboxState.STARTING)

    try {
      await sandboxApi.recoverSandbox(id, selectedOrganization?.id)
      toast.success('Box recovered. Restarting...')
      await markAllSandboxQueriesAsStale()
    } catch (error) {
      handleApiError(error, 'Failed to recover box')
      revertSandboxStateOptimisticUpdate(id, previousState)
    } finally {
      setSandboxIsLoading((prev) => ({ ...prev, [id]: false }))
      setTimeout(() => {
        setSandboxStateIsTransitioning((prev) => ({ ...prev, [id]: false }))
      }, 2000)
    }
  }

  const handleStop = async (id: string) => {
    setSandboxIsLoading((prev) => ({ ...prev, [id]: true }))
    setSandboxStateIsTransitioning((prev) => ({ ...prev, [id]: true }))

    const sandboxToStop = sandboxesData?.items.find((s) => s.id === id)
    const previousState = sandboxToStop?.state

    await cancelQueryRefetches(queryKey)
    performSandboxStateOptimisticUpdate(id, SandboxState.STOPPING)

    try {
      await sandboxApi.stopSandbox(id, selectedOrganization?.id)
      toast.success(
        `Stopping box with ID: ${id}`,
        sandboxToStop?.autoDeleteInterval !== undefined && sandboxToStop.autoDeleteInterval >= 0
          ? {
              description: `This box will be deleted automatically ${sandboxToStop.autoDeleteInterval === 0 ? 'upon stopping' : `in ${formatDuration(sandboxToStop.autoDeleteInterval)} unless it is started again`}.`,
            }
          : undefined,
      )
      await markAllSandboxQueriesAsStale()
    } catch (error) {
      handleApiError(error, 'Failed to stop box')
      revertSandboxStateOptimisticUpdate(id, previousState)
    } finally {
      setSandboxIsLoading((prev) => ({ ...prev, [id]: false }))
      setTimeout(() => {
        setSandboxStateIsTransitioning((prev) => ({ ...prev, [id]: false }))
      }, 2000)
    }
  }

  const handleDelete = async (id: string) => {
    setSandboxIsLoading((prev) => ({ ...prev, [id]: true }))
    setSandboxStateIsTransitioning((prev) => ({ ...prev, [id]: true }))

    const sandboxToDelete = sandboxesData?.items.find((s) => s.id === id)
    const previousState = sandboxToDelete?.state

    await cancelQueryRefetches(queryKey)
    performSandboxStateOptimisticUpdate(id, SandboxState.DESTROYING)

    try {
      await sandboxApi.deleteSandbox(id, selectedOrganization?.id)
      setSandboxToDelete(null)
      setShowDeleteDialog(false)
      removeSandboxFromCache(id)

      toast.success(`Deleting box with ID: ${id}`)

      await markAllSandboxQueriesAsStale()
    } catch (error) {
      handleApiError(error, 'Failed to delete box')
      revertSandboxStateOptimisticUpdate(id, previousState)
    } finally {
      setSandboxIsLoading((prev) => ({ ...prev, [id]: false }))
      setTimeout(() => {
        setSandboxStateIsTransitioning((prev) => ({ ...prev, [id]: false }))
      }, 2000)
    }
  }

  // todo(rpavlini): we should refactor this and move to react-query mutations
  const executeBulkAction = useCallback(
    async ({
      ids,
      actionName,
      optimisticState,
      apiCall,
      toastMessages,
    }: {
      ids: string[]
      actionName: string
      optimisticState: SandboxState
      apiCall: (id: string) => Promise<unknown>
      toastMessages: {
        successTitle: string
        errorTitle: string
        warningTitle: string
        canceledTitle: string
      }
    }) => {
      await cancelQueryRefetches(queryKey)

      const previousStatesById = new Map((sandboxesData?.items ?? []).map((sandbox) => [sandbox.id, sandbox.state]))

      let isCancelled = false
      let processedCount = 0
      let successCount = 0
      let failureCount = 0
      const successfulIds: string[] = []

      const totalLabel = pluralize(ids.length, 'box', 'boxes')
      const onCancel = () => {
        isCancelled = true
      }

      const bulkToast = createBulkActionToast(`${actionName} 0 of ${totalLabel}.`, {
        action: { label: 'Cancel', onClick: onCancel },
      })

      try {
        for (const id of ids) {
          if (isCancelled) break

          processedCount += 1
          bulkToast.loading(`${actionName} ${processedCount} of ${totalLabel}.`, {
            action: { label: 'Cancel', onClick: onCancel },
          })

          setSandboxIsLoading((prev) => ({ ...prev, [id]: true }))
          setSandboxStateIsTransitioning((prev) => ({ ...prev, [id]: true }))
          performSandboxStateOptimisticUpdate(id, optimisticState)

          try {
            await apiCall(id)
            successCount += 1
            successfulIds.push(id)
          } catch (error) {
            failureCount += 1
            revertSandboxStateOptimisticUpdate(id, previousStatesById.get(id))
            console.error(`${actionName} box failed`, id, error)
          } finally {
            setSandboxIsLoading((prev) => ({ ...prev, [id]: false }))
            setTimeout(() => {
              setSandboxStateIsTransitioning((prev) => ({ ...prev, [id]: false }))
            }, 2000)
          }
        }

        await markAllSandboxQueriesAsStale()
        bulkToast.result({ successCount, failureCount }, toastMessages)
      } catch (error) {
        console.error(`${actionName} boxes failed`, error)
        bulkToast.error(`${actionName} boxes failed.`)
      }

      return { successCount, failureCount, successfulIds }
    },
    [
      cancelQueryRefetches,
      queryKey,
      sandboxesData?.items,
      performSandboxStateOptimisticUpdate,
      revertSandboxStateOptimisticUpdate,
      removeSandboxFromCache,
      markAllSandboxQueriesAsStale,
    ],
  )

  const handleBulkStart = (ids: string[]) =>
    executeBulkAction({
      ids,
      actionName: 'Starting',
      optimisticState: SandboxState.STARTING,
      apiCall: (id) => sandboxApi.startSandbox(id, selectedOrganization?.id),
      toastMessages: {
        successTitle: `${pluralize(ids.length, 'box', 'boxes')} started.`,
        errorTitle: `Failed to start ${pluralize(ids.length, 'box', 'boxes')}.`,
        warningTitle: 'Failed to start some boxes.',
        canceledTitle: 'Start canceled.',
      },
    })

  const handleBulkStop = (ids: string[]) =>
    executeBulkAction({
      ids,
      actionName: 'Stopping',
      optimisticState: SandboxState.STOPPING,
      apiCall: (id) => sandboxApi.stopSandbox(id, selectedOrganization?.id),
      toastMessages: {
        successTitle: `${pluralize(ids.length, 'box', 'boxes')} stopped.`,
        errorTitle: `Failed to stop ${pluralize(ids.length, 'box', 'boxes')}.`,
        warningTitle: 'Failed to stop some boxes.',
        canceledTitle: 'Stop canceled.',
      },
    })

  const handleBulkDelete = async (ids: string[]) => {
    const result = await executeBulkAction({
      ids,
      actionName: 'Deleting',
      optimisticState: SandboxState.DESTROYING,
      apiCall: (id) => sandboxApi.deleteSandbox(id, selectedOrganization?.id),
      toastMessages: {
        successTitle: `${pluralize(ids.length, 'box', 'boxes')} deleted.`,
        errorTitle: `Failed to delete ${pluralize(ids.length, 'box', 'boxes')}.`,
        warningTitle: 'Failed to delete some boxes.',
        canceledTitle: 'Delete canceled.',
      },
    })
    result.successfulIds.forEach(removeSandboxFromCache)
  }

  const getPortPreviewUrl = useCallback(
    async (sandboxId: string, port: number): Promise<string> => {
      setSandboxIsLoading((prev) => ({ ...prev, [sandboxId]: true }))
      try {
        return (await sandboxApi.getSignedPortPreviewUrl(sandboxId, port, selectedOrganization?.id)).data.url
      } finally {
        setSandboxIsLoading((prev) => ({ ...prev, [sandboxId]: false }))
      }
    },
    [sandboxApi, selectedOrganization],
  )

  const handleVnc = async (id: string) => {
    navigate(generatePath(RoutePath.BOX_VNC, { sandboxId: id }))
  }

  const getWebTerminalUrl = useCallback(
    async (sandboxId: string): Promise<string | null> => {
      try {
        return await getPortPreviewUrl(sandboxId, 22222)
      } catch (error) {
        handleApiError(error, 'Failed to construct web terminal URL')
        return null
      }
    },
    [getPortPreviewUrl],
  )

  const handleScreenRecordings = async (id: string) => {
    // Check if sandbox is started
    const sandbox = sandboxesData?.items?.find((s) => s.id === id)
    if (!sandbox || sandbox.state !== SandboxState.STARTED) {
      toast.error('Box must be started to access Screen Recordings')
      return
    }

    setSandboxIsLoading((prev) => ({ ...prev, [id]: true }))
    try {
      const portPreviewUrl = await getPortPreviewUrl(id, 33333)
      window.open(portPreviewUrl, '_blank')
      toast.success('Opening Screen Recordings dashboard...')
    } catch (error) {
      handleApiError(error, 'Failed to open Screen Recordings')
    } finally {
      setSandboxIsLoading((prev) => ({ ...prev, [id]: false }))
    }
  }

  const handleCreateSshAccess = async (id: string) => {
    setSandboxIsLoading((prev) => ({ ...prev, [id]: true }))
    try {
      const response = await sandboxApi.createSshAccess(id, selectedOrganization?.id, sshExpiryMinutes)
      setSshAccess(response.data)
      setSshSandboxId(id)
      setShowCreateSshDialog(true)
      toast.success('SSH access created successfully')
    } catch (error) {
      handleApiError(error, 'Failed to create SSH access')
    } finally {
      setSandboxIsLoading((prev) => ({ ...prev, [id]: false }))
    }
  }

  const openCreateSshDialog = (id: string) => {
    setSshSandboxId(id)
    setShowCreateSshDialog(true)
  }

  const handleRevokeSshAccess = async (id: string) => {
    if (!revokeSshToken.trim()) {
      toast.error('Please enter a token to revoke')
      return
    }

    setSandboxIsLoading((prev) => ({ ...prev, [id]: true }))
    try {
      await sandboxApi.revokeSshAccess(id, selectedOrganization?.id, revokeSshToken)
      setRevokeSshToken('')
      setSshSandboxId('')
      setShowRevokeSshDialog(false)
      toast.success('SSH access revoked successfully')
    } catch (error) {
      handleApiError(error, 'Failed to revoke SSH access')
    } finally {
      setSandboxIsLoading((prev) => ({ ...prev, [id]: false }))
    }
  }

  const openRevokeSshDialog = (id: string) => {
    setSshSandboxId(id)
    setShowRevokeSshDialog(true)
  }

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(label)
      setTimeout(() => setCopied(null), 2000)
    } catch (err) {
      console.error('Failed to copy text:', err)
    }
  }

  useEffect(() => {
    if (!selectedOrganization || !user?.profile.sub) {
      return
    }

    const skipOnboardingKey = `${LocalStorageKey.SkipOnboardingPrefix}${user.profile.sub}`
    const shouldOpenFromUrl = searchParams.get('onboarding') === '1'
    const shouldSkipOnboarding = getLocalStorageItem(skipOnboardingKey) === 'true'

    if (shouldOpenFromUrl || !shouldSkipOnboarding) {
      setShowOnboardingDialog(true)
    }
  }, [searchParams, selectedOrganization, user?.profile.sub])

  useEffect(() => {
    const handleOpenOnboarding = (event: Event) => {
      event.preventDefault()
      setShowOnboardingDialog(true)
    }

    window.addEventListener(ONBOARDING_OPEN_EVENT, handleOpenOnboarding)
    return () => window.removeEventListener(ONBOARDING_OPEN_EVENT, handleOpenOnboarding)
  }, [])

  const clearOnboardingUrlParam = useCallback(() => {
    if (searchParams.get('onboarding') !== '1') {
      return
    }
    const nextParams = new URLSearchParams(searchParams)
    nextParams.delete('onboarding')
    setSearchParams(nextParams, { replace: true })
  }, [searchParams, setSearchParams])

  const closeOnboardingDialog = useCallback(() => {
    if (userId) {
      setLocalStorageItem(`${LocalStorageKey.SkipOnboardingPrefix}${userId}`, 'true')
    }
    setShowOnboardingDialog(false)
    window.setTimeout(() => {
      window.dispatchEvent(new Event(ONBOARDING_ENTRY_HIGHLIGHT_EVENT))
      clearOnboardingUrlParam()
    }, 220)
  }, [clearOnboardingUrlParam, userId])

  useEffect(() => {
    const state = location.state as SandboxesLocationState | null
    if (!state?.openCreateBox) {
      return
    }

    setShowOnboardingDialog(false)
    setCreateSandboxOpen(true)
    navigate({ pathname: location.pathname, search: location.search }, { replace: true, state: null })
  }, [location.pathname, location.search, location.state, navigate])

  return (
    <PageLayout>
      <OnboardingGuideDialog
        open={showOnboardingDialog}
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            closeOnboardingDialog()
          } else {
            setShowOnboardingDialog(true)
          }
        }}
        onProgressChange={updateOnboardingProgress}
        progress={onboardingProgress}
      />
      <PageContent size="full" className="min-h-0 flex-1 gap-3 max-h-[calc(100vh-65px)] pt-4">
        <SandboxTable
          sandboxIsLoading={sandboxIsLoading}
          sandboxStateIsTransitioning={sandboxStateIsTransitioning}
          handleStart={handleStart}
          handleStop={handleStop}
          handleDelete={(id: string) => {
            setSandboxToDelete(id)
            setShowDeleteDialog(true)
          }}
          handleBulkDelete={handleBulkDelete}
          handleBulkStart={handleBulkStart}
          handleBulkStop={handleBulkStop}
          handleVnc={handleVnc}
          getWebTerminalUrl={getWebTerminalUrl}
          handleCreateSshAccess={openCreateSshDialog}
          handleRevokeSshAccess={openRevokeSshDialog}
          handleRefresh={handleRefresh}
          isRefreshing={sandboxDataIsRefreshing}
          data={sandboxesData?.items || []}
          loading={sandboxesDataIsLoading}
          templates={templatesData || []}
          templatesDataIsLoading={templatesDataIsLoading}
          onRowClick={(sandbox: Sandbox) => {
            navigate(generatePath(RoutePath.BOX_DETAILS, { sandboxId: getSandboxRouteId(sandbox) }))
          }}
          pageCount={sandboxesData?.totalPages || 0}
          totalItems={sandboxesData?.total || 0}
          onPaginationChange={handlePaginationChange}
          pagination={{
            pageIndex: paginationParams.pageIndex,
            pageSize: paginationParams.pageSize,
          }}
          sorting={sorting}
          onSortingChange={handleSortingChange}
          filters={filters}
          onFiltersChange={handleFiltersChange}
          handleRecover={handleRecover}
          getRegionName={getRegionName}
          handleScreenRecordings={handleScreenRecordings}
          headerAction={
            authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_SANDBOXES) ? (
              <CreateSandboxSheet
                open={createSandboxOpen}
                onOpenChange={setCreateSandboxOpen}
                onCreated={() => {
                  updateOnboardingProgress({ boxCreated: true })
                  setShowOnboardingDialog(false)
                }}
                triggerClassName="w-full sm:w-auto"
              />
            ) : null
          }
        />

        {sandboxToDelete && (
          <AlertDialog
            open={showDeleteDialog}
            onOpenChange={(isOpen) => {
              setShowDeleteDialog(isOpen)
              if (!isOpen) {
                setSandboxToDelete(null)
              }
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Confirm Box Deletion</AlertDialogTitle>
                <AlertDialogDescription>
                  Are you sure you want to delete this box? This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => handleDelete(sandboxToDelete)}
                  disabled={sandboxIsLoading[sandboxToDelete]}
                >
                  {sandboxIsLoading[sandboxToDelete] ? 'Deleting...' : 'Delete'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}

        {/* Create SSH Access Dialog */}
        <AlertDialog
          open={showCreateSshDialog}
          onOpenChange={(isOpen) => {
            setShowCreateSshDialog(isOpen)
            if (!isOpen) {
              setSshAccess(null)
              setSshExpiryMinutes(60)
              setSshSandboxId('')
            }
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Create SSH Access</AlertDialogTitle>
              <AlertDialogDescription>
                {sshAccess
                  ? 'SSH access has been created successfully. Use the token below to connect:'
                  : 'Set the expiration time for SSH access:'}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="space-y-4">
              {!sshAccess ? (
                <div className="space-y-3">
                  <Label className="text-sm font-medium">Expiry (minutes):</Label>
                  <input
                    type="number"
                    min="1"
                    max="1440"
                    value={sshExpiryMinutes}
                    onChange={(e) => setSshExpiryMinutes(Number(e.target.value))}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                </div>
              ) : (
                <CopyableValue
                  displayValue={sshAccess.sshCommand}
                  copyValue={sshAccess.sshCommand}
                  copyLabel="SSH command"
                  copied={copied === 'SSH Command'}
                  onCopy={(value) => copyToClipboard(value, 'SSH Command')}
                />
              )}
            </div>
            <AlertDialogFooter>
              {!sshAccess ? (
                <>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => handleCreateSshAccess(sshSandboxId)}
                    disabled={!sshSandboxId}
                    className="bg-secondary text-secondary-foreground hover:bg-secondary/80"
                  >
                    Create
                  </AlertDialogAction>
                </>
              ) : (
                <AlertDialogAction
                  onClick={() => setShowCreateSshDialog(false)}
                  className="bg-secondary text-secondary-foreground hover:bg-secondary/80"
                >
                  Close
                </AlertDialogAction>
              )}
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Revoke SSH Access Dialog */}
        <AlertDialog
          open={showRevokeSshDialog}
          onOpenChange={(isOpen) => {
            setShowRevokeSshDialog(isOpen)
            if (!isOpen) {
              setRevokeSshToken('')
              setSshSandboxId('')
            }
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Revoke SSH Access</AlertDialogTitle>
              <AlertDialogDescription>Enter the SSH access token you want to revoke:</AlertDialogDescription>
            </AlertDialogHeader>
            <div className="space-y-4">
              <div className="space-y-3">
                <label className="text-sm font-medium">SSH Token:</label>
                <input
                  type="text"
                  value={revokeSshToken}
                  onChange={(e) => setRevokeSshToken(e.target.value)}
                  placeholder="Enter SSH token to revoke"
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                />
              </div>
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => handleRevokeSshAccess(sshSandboxId)}
                disabled={!revokeSshToken.trim() || !sshSandboxId}
                className="bg-secondary text-secondary-foreground hover:bg-secondary/80"
              >
                Revoke Access
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </PageContent>
    </PageLayout>
  )
}

export default Sandboxes
