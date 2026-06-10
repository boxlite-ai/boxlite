/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationSuspendedError } from '@/api/errors'
import { OnboardingGuideDialog } from '@/components/OnboardingGuideDialog'
import { PageContent, PageLayout } from '@/components/PageLayout'
import { CreateBoxSheet } from '@/components/Box/CreateBoxSheet'
import { BoxTable } from '@/components/BoxTable'
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
import { CopyableValue } from '@/components/ui/copyable-value'
import { useApi } from '@/hooks/useApi'
import { useConfig } from '@/hooks/useConfig'
import { useNotificationSocket } from '@/hooks/useNotificationSocket'
import { useRegions } from '@/hooks/useRegions'
import {
  DEFAULT_BOX_SORTING,
  getBoxesQueryKey,
  BoxFilters,
  BoxQueryParams,
  BoxSorting,
  useBoxes,
} from '@/hooks/useBoxes'
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
import { getBoxRouteId } from '@/lib/box-identity'
import { formatDuration, pluralize } from '@/lib/utils'
import {
  OrganizationRolePermissionsEnum,
  OrganizationUserRoleEnum,
  Box,
  BoxDesiredState,
  BoxState,
  SshAccessDto,
} from '@boxlite-ai/api-client'
import { QueryKey, useQueryClient } from '@tanstack/react-query'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { generatePath, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

interface BoxesLocationState {
  openCreateBox?: boolean
}

const Boxes: React.FC = () => {
  const { boxApi } = useApi()
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
  const [createBoxOpen, setCreateBoxOpen] = useState(false)
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

  const [filters, setFilters] = useState<BoxFilters>({})

  const handleFiltersChange = useCallback((filters: BoxFilters) => {
    setFilters(filters)
    setPaginationParams((prev) => ({ ...prev, pageIndex: 0 }))
  }, [])

  // Sorting

  const [sorting, setSorting] = useState<BoxSorting>(DEFAULT_BOX_SORTING)

  const handleSortingChange = useCallback((sorting: BoxSorting) => {
    setSorting(sorting)
    setPaginationParams((prev) => ({ ...prev, pageIndex: 0 }))
  }, [])

  // Boxes Data

  const queryParams = useMemo<BoxQueryParams>(
    () => ({
      page: paginationParams.pageIndex + 1, // 1-indexed
      pageSize: paginationParams.pageSize,
      filters: filters,
      sorting: sorting,
    }),
    [paginationParams, filters, sorting],
  )

  const baseQueryKey = useMemo<QueryKey>(() => getBoxesQueryKey(selectedOrganization?.id), [selectedOrganization?.id])

  const queryKey = useMemo<QueryKey>(
    () => getBoxesQueryKey(selectedOrganization?.id, queryParams),
    [selectedOrganization?.id, queryParams],
  )

  const {
    data: boxesData,
    isLoading: boxesDataIsLoading,
    error: boxesDataError,
    refetch: refetchBoxesData,
  } = useBoxes(queryKey, queryParams)
  const hasBoxes = (boxesData?.items.length ?? 0) > 0 || (boxesData?.total ?? 0) > 0

  useEffect(() => {
    if (boxesDataError) {
      handleApiError(boxesDataError, 'Failed to fetch boxes')
    }
  }, [boxesDataError])

  const updateBoxInCache = useCallback(
    (boxId: string, updates: Partial<Box>) => {
      queryClient.setQueryData(queryKey, (oldData: any) => {
        if (!oldData?.items) return oldData
        return {
          ...oldData,
          items: oldData.items.map((box: Box) => (box.id === boxId ? { ...box, ...updates } : box)),
        }
      })
    },
    [queryClient, queryKey],
  )

  const removeBoxFromCache = useCallback(
    (boxId: string) => {
      queryClient.setQueryData(queryKey, (oldData: any) => {
        if (!oldData?.items) return oldData
        const nextItems = oldData.items.filter((box: Box) => box.id !== boxId)
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
   * Marks all box queries for this organization as stale.
   *
   * Useful when box event occurs and we don't have a good way of knowing for which combination of query parameters the box would be shown.
   *
   * @param shouldRefetchActiveQueries If true, only active queries will be refetched. Otherwise, no queries will be refetched.
   */
  const markAllBoxQueriesAsStale = useCallback(
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
    if (boxesData?.items.length === 0 && paginationParams.pageIndex > 0) {
      setPaginationParams((prev) => ({
        ...prev,
        pageIndex: prev.pageIndex - 1,
      }))
    }
  }, [boxesData?.items.length, paginationParams.pageIndex])

  // Ephemeral Box States

  const [boxIsLoading, setBoxIsLoading] = useState<Record<string, boolean>>({})
  const [boxStateIsTransitioning, setBoxStateIsTransitioning] = useState<Record<string, boolean>>({}) // display transition animation

  // Manual Refreshing

  const [boxDataIsRefreshing, setBoxDataIsRefreshing] = useState(false)

  const handleRefresh = useCallback(async () => {
    setBoxDataIsRefreshing(true)
    try {
      await refetchBoxesData()
    } catch (error) {
      handleApiError(error, 'Failed to refresh boxes')
    } finally {
      setBoxDataIsRefreshing(false)
    }
  }, [refetchBoxesData])

  // Delete Box Dialog

  const [boxToDelete, setBoxToDelete] = useState<string | null>(null)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)

  const performBoxStateOptimisticUpdate = useCallback(
    (boxId: string, newState: BoxState) => {
      updateBoxInCache(boxId, { state: newState })
    },
    [updateBoxInCache],
  )

  const revertBoxStateOptimisticUpdate = useCallback(
    (boxId: string, previousState?: BoxState) => {
      if (!previousState) {
        return
      }

      updateBoxInCache(boxId, { state: previousState })
    },
    [updateBoxInCache],
  )

  // SSH Access Dialogs

  const [showCreateSshDialog, setShowCreateSshDialog] = useState(false)
  const [showRevokeSshDialog, setShowRevokeSshDialog] = useState(false)
  const [sshAccess, setSshAccess] = useState<SshAccessDto | null>(null)
  const [sshExpiryMinutes, setSshExpiryMinutes] = useState<number>(60)
  const [revokeSshToken, setRevokeSshToken] = useState<string>('')
  const [sshBoxId, setSshBoxId] = useState<string>('')
  const [copied, setCopied] = useState<string | null>(null)

  // TODO(image-rewrite): template/image listing removed with the image/template subsystem.

  const { getRegionName } = useRegions()

  // Subscribe to Box Events

  useEffect(() => {
    const handleBoxCreatedEvent = () => {
      updateOnboardingProgress({ boxCreated: true })

      const isFirstPage = paginationParams.pageIndex === 0
      const isDefaultFilters = Object.keys(filters).length === 0
      const isDefaultSorting =
        sorting.field === DEFAULT_BOX_SORTING.field && sorting.direction === DEFAULT_BOX_SORTING.direction

      const shouldRefetchActiveQueries = isFirstPage && isDefaultFilters && isDefaultSorting

      markAllBoxQueriesAsStale(shouldRefetchActiveQueries)
    }

    const handleBoxStateUpdatedEvent = (data: { box: Box; oldState: BoxState; newState: BoxState }) => {
      // warm pool boxes
      if (data.oldState === data.newState && data.newState === BoxState.STARTED) {
        handleBoxCreatedEvent()
        return
      }

      let updatedState = data.newState

      // error,build_failed | destroyed should be displayed as destroyed in the UI
      if (
        data.box.desiredState === BoxDesiredState.DESTROYED &&
        (data.newState === BoxState.ERROR || data.newState === BoxState.BUILD_FAILED)
      ) {
        updatedState = BoxState.DESTROYED
      }

      if (updatedState === BoxState.DESTROYED) {
        removeBoxFromCache(data.box.id)
      } else {
        performBoxStateOptimisticUpdate(data.box.id, updatedState)
      }

      markAllBoxQueriesAsStale()
    }

    const handleBoxDesiredStateUpdatedEvent = (data: {
      box: Box
      oldDesiredState: BoxDesiredState
      newDesiredState: BoxDesiredState
    }) => {
      // error,build_failed | destroyed should be displayed as destroyed in the UI

      if (data.newDesiredState !== BoxDesiredState.DESTROYED) {
        return
      }

      if (data.box.state !== BoxState.ERROR && data.box.state !== BoxState.BUILD_FAILED) {
        return
      }

      removeBoxFromCache(data.box.id)

      markAllBoxQueriesAsStale()
    }

    if (!notificationSocket) {
      return
    }

    notificationSocket.on('box.created', handleBoxCreatedEvent)
    notificationSocket.on('box.state.updated', handleBoxStateUpdatedEvent)
    notificationSocket.on('box.desired-state.updated', handleBoxDesiredStateUpdatedEvent)

    return () => {
      notificationSocket.off('box.created', handleBoxCreatedEvent)
      notificationSocket.off('box.state.updated', handleBoxStateUpdatedEvent)
      notificationSocket.off('box.desired-state.updated', handleBoxDesiredStateUpdatedEvent)
    }
  }, [
    filters,
    markAllBoxQueriesAsStale,
    notificationSocket,
    paginationParams.pageIndex,
    performBoxStateOptimisticUpdate,
    removeBoxFromCache,
    sorting.direction,
    sorting.field,
    updateOnboardingProgress,
  ])

  useEffect(() => {
    if (hasBoxes && !onboardingProgress.boxCreated) {
      updateOnboardingProgress({ boxCreated: true })
    }
  }, [hasBoxes, onboardingProgress.boxCreated, updateOnboardingProgress])

  // Box Action Handlers

  const handleStart = async (id: string) => {
    setBoxIsLoading((prev) => ({ ...prev, [id]: true }))
    setBoxStateIsTransitioning((prev) => ({ ...prev, [id]: true }))

    const boxToStart = boxesData?.items.find((s) => s.id === id)
    const previousState = boxToStart?.state

    await cancelQueryRefetches(queryKey)
    performBoxStateOptimisticUpdate(id, BoxState.STARTING)

    try {
      await boxApi.startBox(id, selectedOrganization?.id)
      toast.success(`Starting box with ID: ${id}`)
      await markAllBoxQueriesAsStale()
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
      revertBoxStateOptimisticUpdate(id, previousState)
    } finally {
      setBoxIsLoading((prev) => ({ ...prev, [id]: false }))
      setTimeout(() => {
        setBoxStateIsTransitioning((prev) => ({ ...prev, [id]: false }))
      }, 2000)
    }
  }

  const handleRecover = async (id: string) => {
    setBoxIsLoading((prev) => ({ ...prev, [id]: true }))
    setBoxStateIsTransitioning((prev) => ({ ...prev, [id]: true }))

    const boxToRecover = boxesData?.items.find((s) => s.id === id)
    const previousState = boxToRecover?.state

    await cancelQueryRefetches(queryKey)
    performBoxStateOptimisticUpdate(id, BoxState.STARTING)

    try {
      await boxApi.recoverBox(id, selectedOrganization?.id)
      toast.success('Box recovered. Restarting...')
      await markAllBoxQueriesAsStale()
    } catch (error) {
      handleApiError(error, 'Failed to recover box')
      revertBoxStateOptimisticUpdate(id, previousState)
    } finally {
      setBoxIsLoading((prev) => ({ ...prev, [id]: false }))
      setTimeout(() => {
        setBoxStateIsTransitioning((prev) => ({ ...prev, [id]: false }))
      }, 2000)
    }
  }

  const handleStop = async (id: string) => {
    setBoxIsLoading((prev) => ({ ...prev, [id]: true }))
    setBoxStateIsTransitioning((prev) => ({ ...prev, [id]: true }))

    const boxToStop = boxesData?.items.find((s) => s.id === id)
    const previousState = boxToStop?.state

    await cancelQueryRefetches(queryKey)
    performBoxStateOptimisticUpdate(id, BoxState.STOPPING)

    try {
      await boxApi.stopBox(id, selectedOrganization?.id)
      toast.success(
        `Stopping box with ID: ${id}`,
        boxToStop?.autoDeleteInterval !== undefined && boxToStop.autoDeleteInterval >= 0
          ? {
              description: `This box will be deleted automatically ${boxToStop.autoDeleteInterval === 0 ? 'upon stopping' : `in ${formatDuration(boxToStop.autoDeleteInterval)} unless it is started again`}.`,
            }
          : undefined,
      )
      await markAllBoxQueriesAsStale()
    } catch (error) {
      handleApiError(error, 'Failed to stop box')
      revertBoxStateOptimisticUpdate(id, previousState)
    } finally {
      setBoxIsLoading((prev) => ({ ...prev, [id]: false }))
      setTimeout(() => {
        setBoxStateIsTransitioning((prev) => ({ ...prev, [id]: false }))
      }, 2000)
    }
  }

  const handleDelete = async (id: string) => {
    setBoxIsLoading((prev) => ({ ...prev, [id]: true }))
    setBoxStateIsTransitioning((prev) => ({ ...prev, [id]: true }))

    const boxToDelete = boxesData?.items.find((s) => s.id === id)
    const previousState = boxToDelete?.state

    await cancelQueryRefetches(queryKey)
    performBoxStateOptimisticUpdate(id, BoxState.DESTROYING)

    try {
      await boxApi.deleteBox(id, selectedOrganization?.id)
      setBoxToDelete(null)
      setShowDeleteDialog(false)
      removeBoxFromCache(id)

      toast.success(`Deleting box with ID: ${id}`)

      await markAllBoxQueriesAsStale()
    } catch (error) {
      handleApiError(error, 'Failed to delete box')
      revertBoxStateOptimisticUpdate(id, previousState)
    } finally {
      setBoxIsLoading((prev) => ({ ...prev, [id]: false }))
      setTimeout(() => {
        setBoxStateIsTransitioning((prev) => ({ ...prev, [id]: false }))
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
      optimisticState: BoxState
      apiCall: (id: string) => Promise<unknown>
      toastMessages: {
        successTitle: string
        errorTitle: string
        warningTitle: string
        canceledTitle: string
      }
    }) => {
      await cancelQueryRefetches(queryKey)

      const previousStatesById = new Map((boxesData?.items ?? []).map((box) => [box.id, box.state]))

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

          setBoxIsLoading((prev) => ({ ...prev, [id]: true }))
          setBoxStateIsTransitioning((prev) => ({ ...prev, [id]: true }))
          performBoxStateOptimisticUpdate(id, optimisticState)

          try {
            await apiCall(id)
            successCount += 1
            successfulIds.push(id)
          } catch (error) {
            failureCount += 1
            revertBoxStateOptimisticUpdate(id, previousStatesById.get(id))
            console.error(`${actionName} box failed`, id, error)
          } finally {
            setBoxIsLoading((prev) => ({ ...prev, [id]: false }))
            setTimeout(() => {
              setBoxStateIsTransitioning((prev) => ({ ...prev, [id]: false }))
            }, 2000)
          }
        }

        await markAllBoxQueriesAsStale()
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
      boxesData?.items,
      performBoxStateOptimisticUpdate,
      revertBoxStateOptimisticUpdate,
      removeBoxFromCache,
      markAllBoxQueriesAsStale,
    ],
  )

  const handleBulkStart = (ids: string[]) =>
    executeBulkAction({
      ids,
      actionName: 'Starting',
      optimisticState: BoxState.STARTING,
      apiCall: (id) => boxApi.startBox(id, selectedOrganization?.id),
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
      optimisticState: BoxState.STOPPING,
      apiCall: (id) => boxApi.stopBox(id, selectedOrganization?.id),
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
      optimisticState: BoxState.DESTROYING,
      apiCall: (id) => boxApi.deleteBox(id, selectedOrganization?.id),
      toastMessages: {
        successTitle: `${pluralize(ids.length, 'box', 'boxes')} deleted.`,
        errorTitle: `Failed to delete ${pluralize(ids.length, 'box', 'boxes')}.`,
        warningTitle: 'Failed to delete some boxes.',
        canceledTitle: 'Delete canceled.',
      },
    })
    result.successfulIds.forEach(removeBoxFromCache)
  }

  const getPortPreviewUrl = useCallback(
    async (boxId: string, port: number): Promise<string> => {
      setBoxIsLoading((prev) => ({ ...prev, [boxId]: true }))
      try {
        return (await boxApi.getSignedPortPreviewUrl(boxId, port, selectedOrganization?.id)).data.url
      } finally {
        setBoxIsLoading((prev) => ({ ...prev, [boxId]: false }))
      }
    },
    [boxApi, selectedOrganization],
  )

  const handleVnc = async (id: string) => {
    navigate(generatePath(RoutePath.BOX_VNC, { boxId: id }))
  }

  const getWebTerminalUrl = useCallback(
    async (boxId: string): Promise<string | null> => {
      try {
        return await getPortPreviewUrl(boxId, 22222)
      } catch (error) {
        handleApiError(error, 'Failed to construct web terminal URL')
        return null
      }
    },
    [getPortPreviewUrl],
  )

  const handleScreenRecordings = async (id: string) => {
    // Check if box is started
    const box = boxesData?.items?.find((s) => s.id === id)
    if (!box || box.state !== BoxState.STARTED) {
      toast.error('Box must be started to access Screen Recordings')
      return
    }

    setBoxIsLoading((prev) => ({ ...prev, [id]: true }))
    try {
      const portPreviewUrl = await getPortPreviewUrl(id, 33333)
      window.open(portPreviewUrl, '_blank')
      toast.success('Opening Screen Recordings dashboard...')
    } catch (error) {
      handleApiError(error, 'Failed to open Screen Recordings')
    } finally {
      setBoxIsLoading((prev) => ({ ...prev, [id]: false }))
    }
  }

  const handleCreateSshAccess = async (id: string) => {
    setBoxIsLoading((prev) => ({ ...prev, [id]: true }))
    try {
      const response = await boxApi.createSshAccess(id, selectedOrganization?.id, sshExpiryMinutes)
      setSshAccess(response.data)
      setSshBoxId(id)
      setShowCreateSshDialog(true)
      toast.success('SSH access created successfully')
    } catch (error) {
      handleApiError(error, 'Failed to create SSH access')
    } finally {
      setBoxIsLoading((prev) => ({ ...prev, [id]: false }))
    }
  }

  const openCreateSshDialog = (id: string) => {
    setSshBoxId(id)
    setShowCreateSshDialog(true)
  }

  const handleRevokeSshAccess = async (id: string) => {
    if (!revokeSshToken.trim()) {
      toast.error('Please enter a token to revoke')
      return
    }

    setBoxIsLoading((prev) => ({ ...prev, [id]: true }))
    try {
      await boxApi.revokeSshAccess(id, selectedOrganization?.id, revokeSshToken)
      setRevokeSshToken('')
      setSshBoxId('')
      setShowRevokeSshDialog(false)
      toast.success('SSH access revoked successfully')
    } catch (error) {
      handleApiError(error, 'Failed to revoke SSH access')
    } finally {
      setBoxIsLoading((prev) => ({ ...prev, [id]: false }))
    }
  }

  const openRevokeSshDialog = (id: string) => {
    setSshBoxId(id)
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
    const state = location.state as BoxesLocationState | null
    if (!state?.openCreateBox) {
      return
    }

    setShowOnboardingDialog(false)
    setCreateBoxOpen(true)
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
        <BoxTable
          boxIsLoading={boxIsLoading}
          boxStateIsTransitioning={boxStateIsTransitioning}
          handleStart={handleStart}
          handleStop={handleStop}
          handleDelete={(id: string) => {
            setBoxToDelete(id)
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
          isRefreshing={boxDataIsRefreshing}
          data={boxesData?.items || []}
          loading={boxesDataIsLoading}
          onRowClick={(box: Box) => {
            navigate(generatePath(RoutePath.BOX_DETAILS, { boxId: getBoxRouteId(box) }))
          }}
          pageCount={boxesData?.totalPages || 0}
          totalItems={boxesData?.total || 0}
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
            authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_BOXES) ? (
              <CreateBoxSheet
                open={createBoxOpen}
                onOpenChange={setCreateBoxOpen}
                onCreated={() => {
                  updateOnboardingProgress({ boxCreated: true })
                  setShowOnboardingDialog(false)
                }}
                triggerClassName="w-full sm:w-auto"
              />
            ) : null
          }
        />

        {boxToDelete && (
          <AlertDialog
            open={showDeleteDialog}
            onOpenChange={(isOpen) => {
              setShowDeleteDialog(isOpen)
              if (!isOpen) {
                setBoxToDelete(null)
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
                  onClick={() => handleDelete(boxToDelete)}
                  disabled={boxIsLoading[boxToDelete]}
                >
                  {boxIsLoading[boxToDelete] ? 'Deleting...' : 'Delete'}
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
              setSshBoxId('')
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
                    onClick={() => handleCreateSshAccess(sshBoxId)}
                    disabled={!sshBoxId}
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
              setSshBoxId('')
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
                onClick={() => handleRevokeSshAccess(sshBoxId)}
                disabled={!revokeSshToken.trim() || !sshBoxId}
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

export default Boxes
