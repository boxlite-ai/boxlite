/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationSuspendedError } from '@/api/errors'
import { OnboardingGuideDialog } from '@/components/OnboardingGuideDialog'
import { CreateBoxDialog } from '@/components/Box/CreateBoxDialog'
import { BoxTable } from '@/components/BoxTable'
import { Search } from '@/components/ui/icon'
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
import { DEFAULT_PAGE_SIZE } from '@/constants/Pagination'
import { LocalStorageKey } from '@/enums/LocalStorageKey'
import { RoutePath } from '@/enums/RoutePath'
import { useApi } from '@/hooks/useApi'
import { deleteBoxViaBoxApi, formatLifecycleSeconds, startBoxViaBoxApi, stopBoxViaBoxApi } from '@/lib/cloudBox'
import { useConfig } from '@/hooks/useConfig'
import { useNotificationSocket } from '@/hooks/useNotificationSocket'
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
  mergeOnboardingProgress,
  ONBOARDING_PROGRESS_EVENT,
  readOnboardingProgress,
  type OnboardingProgress,
} from '@/lib/onboarding-progress'
import { getBoxRouteId } from '@/lib/box-identity'
import { pluralize } from '@/lib/utils'
import {
  OrganizationRolePermissionsEnum,
  OrganizationUserRoleEnum,
  Box,
  BoxDesiredState,
  BoxState,
  ListBoxesPaginatedStatesEnum,
} from '@boxlite-ai/api-client'
import { QueryKey, useQuery, useQueryClient } from '@tanstack/react-query'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { generatePath, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

interface BoxesLocationState {
  openCreateBox?: boolean
}

const Boxes: React.FC = () => {
  const api = useApi()
  const { boxApi } = api
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
    isPlaceholderData: boxesDataIsPlaceholderData,
    error: boxesDataError,
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
      // The stat-card counts live under a separate query key, so the list
      // invalidation above misses them. Refetch them on every box change
      // (action or socket push) so the cards stay in sync with the list.
      queryClient.invalidateQueries({ queryKey: ['boxesCount'], refetchType: 'active' })
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

  // TODO(image-rewrite): template/image listing removed with the image/template subsystem.

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

      // error | destroyed should be displayed as destroyed in the UI
      if (data.box.desiredState === BoxDesiredState.DESTROYED && data.newState === BoxState.ERROR) {
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
      // error | destroyed should be displayed as destroyed in the UI

      if (data.newDesiredState !== BoxDesiredState.DESTROYED) {
        return
      }

      if (data.box.state !== BoxState.ERROR) {
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
      if (!selectedOrganization?.id) throw new Error('Missing organization')
      await startBoxViaBoxApi(api, selectedOrganization.id, id)
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
      if (!selectedOrganization?.id) throw new Error('Missing organization')
      await stopBoxViaBoxApi(api, selectedOrganization.id, id)
      toast.success(
        `Stopping box with ID: ${id}`,
        boxToStop?.autoDelete !== undefined && boxToStop.autoDelete > 0
          ? {
              description: `This box will be deleted automatically in ${formatLifecycleSeconds(boxToStop.autoDelete)} unless it is started again.`,
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
      if (!selectedOrganization?.id) throw new Error('Missing organization')
      await deleteBoxViaBoxApi(api, selectedOrganization.id, id)
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
      apiCall: (id) => {
        if (!selectedOrganization?.id) throw new Error('Missing organization')
        return startBoxViaBoxApi(api, selectedOrganization.id, id)
      },
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
      apiCall: (id) => {
        if (!selectedOrganization?.id) throw new Error('Missing organization')
        return stopBoxViaBoxApi(api, selectedOrganization.id, id)
      },
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
      apiCall: (id) => {
        if (!selectedOrganization?.id) throw new Error('Missing organization')
        return deleteBoxViaBoxApi(api, selectedOrganization.id, id)
      },
      toastMessages: {
        successTitle: `${pluralize(ids.length, 'box', 'boxes')} deleted.`,
        errorTitle: `Failed to delete ${pluralize(ids.length, 'box', 'boxes')}.`,
        warningTitle: 'Failed to delete some boxes.',
        canceledTitle: 'Delete canceled.',
      },
    })
    result.successfulIds.forEach(removeBoxFromCache)
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

  // Fleet stat cards — real data, independent of the table's current filter/page.
  const orgId = selectedOrganization?.id

  // Counts come straight from the paginated endpoint's `total` (limit=1, no full fetch).
  const totalBoxesQuery = useQuery({
    queryKey: ['boxesCount', orgId, 'all'],
    queryFn: async () => (await boxApi.listBoxesPaginated(orgId, 1, 1)).data.total,
    enabled: !!orgId,
    staleTime: 10_000,
  })
  const runningBoxesQuery = useQuery({
    queryKey: ['boxesCount', orgId, 'running'],
    queryFn: async () =>
      (
        await boxApi.listBoxesPaginated(orgId, 1, 1, undefined, undefined, undefined, undefined, [
          ListBoxesPaginatedStatesEnum.STARTED,
        ])
      ).data.total,
    enabled: !!orgId,
    staleTime: 10_000,
  })
  const stoppedBoxesQuery = useQuery({
    queryKey: ['boxesCount', orgId, 'stopped'],
    queryFn: async () =>
      (
        await boxApi.listBoxesPaginated(orgId, 1, 1, undefined, undefined, undefined, undefined, [
          ListBoxesPaginatedStatesEnum.STOPPED,
        ])
      ).data.total,
    enabled: !!orgId,
    staleTime: 10_000,
  })

  const totalBoxesDisplay = totalBoxesQuery.data != null ? totalBoxesQuery.data.toLocaleString('en-US') : '…'
  const runningBoxesDisplay = runningBoxesQuery.data != null ? runningBoxesQuery.data.toLocaleString('en-US') : '…'
  const stoppedBoxesDisplay = stoppedBoxesQuery.data != null ? stoppedBoxesQuery.data.toLocaleString('en-US') : '…'

  return (
    <div className="flex h-[calc(100svh-60px)] min-h-0 flex-col px-4 pt-5 sm:px-6 lg:px-[40px] lg:pt-[26px]">
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
      {/* header */}
      <div className="mb-[18px] flex items-end justify-between lg:mb-[22px]">
        <h1 className="font-mono text-[22px] font-medium leading-none tracking-[-0.5px]">Boxes</h1>
      </div>

      {/* stat cards */}
      <div className="grid grid-cols-3 gap-2 sm:gap-3 lg:gap-[14px]">
        <StatCard label="total boxes" value={totalBoxesDisplay} sub="all states" />
        <StatCard label="running boxes" value={runningBoxesDisplay} sub="active now" live />
        <StatCard label="stopped boxes" value={stoppedBoxesDisplay} sub="idle" />
      </div>

      {/* toolbar */}
      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-stretch lg:mt-[26px]">
        <div className="flex h-11 w-full min-w-0 items-center gap-[11px] border border-dashed border-border bg-card px-[14px] sm:h-9 sm:max-w-[380px] sm:flex-none">
          <Search className="size-[15px] shrink-0" style={{ color: 'hsl(var(--brand))' }} strokeWidth={2} />
          <input
            value={filters.idOrName ?? ''}
            onChange={(e) => handleFiltersChange({ ...filters, idOrName: e.target.value || undefined })}
            placeholder="Filter boxes…"
            className="w-full border-0 bg-transparent p-0 text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
          />
          <span className="whitespace-nowrap font-mono text-[10px] uppercase tracking-[1px] text-muted-foreground">
            {boxesData?.items.length ?? 0}
          </span>
        </div>
        <div className="flex-1" />
        {authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_BOXES) && (
          <CreateBoxDialog
            triggerClassName="h-11 justify-center sm:h-9"
            open={createBoxOpen}
            onOpenChange={setCreateBoxOpen}
            onCreated={() => {
              updateOnboardingProgress({ boxCreated: true })
              setShowOnboardingDialog(false)
            }}
          />
        )}
      </div>

      {/* table */}
      <div className="mt-[14px] flex min-h-0 flex-1 flex-col">
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
          data={boxesData?.items || []}
          loading={boxesDataIsLoading}
          isPageFetching={boxesDataIsPlaceholderData}
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
        />
      </div>

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
    </div>
  )
}

// 5x7 dot-matrix LED glyphs — renders hero numbers as a dot display (telemetry/monitor vibe).
const DM_GLYPHS: Record<string, string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '.': ['00', '00', '00', '00', '00', '11', '11'],
  ',': ['00', '00', '00', '00', '00', '11', '10'],
}

const isNumeric = (s: string) => /^[\d.,]+$/.test(s)

function DotMatrix({ text, dot = 4, gap = 1 }: { text: string; dot?: number; gap?: number }) {
  return (
    <div className="flex items-end" style={{ gap: `${dot + gap}px` }}>
      {[...text].map((ch, i) => {
        const rows = DM_GLYPHS[ch]
        if (!rows) return <span key={i} style={{ width: `${dot * 2}px` }} />
        const cols = rows[0].length
        return (
          <div
            key={i}
            className="grid"
            style={{ gridTemplateColumns: `repeat(${cols}, ${dot}px)`, gridAutoRows: `${dot}px`, gap: `${gap}px` }}
          >
            {rows.flatMap((r, y) =>
              [...r].map((c, x) => (
                <span
                  key={`${y}-${x}`}
                  style={{
                    width: `${dot}px`,
                    height: `${dot}px`,
                    borderRadius: '50%',
                    background: c === '1' ? 'currentColor' : 'transparent',
                  }}
                />
              )),
            )}
          </div>
        )
      })}
    </div>
  )
}

function StatCard({ label, value, sub, live }: { label: string; value: string; sub: string; live?: boolean }) {
  return (
    <div className="flex flex-col gap-2 border border-border bg-card px-3 py-2.5 transition-transform hover:-translate-y-0.5 sm:gap-[14px] sm:px-[22px] sm:pb-5 sm:pt-[18px]">
      <div className="flex items-start justify-between gap-1">
        <span className="font-mono text-[9px] uppercase leading-tight tracking-[1px] text-muted-foreground sm:whitespace-nowrap sm:text-[10px] sm:tracking-[1.5px]">
          <span style={{ color: 'hsl(var(--brand))' }}>▸</span> {label}
        </span>
        {live && (
          <span className="inline-flex shrink-0 items-center gap-[5px] font-mono text-[9px] tracking-[1px] text-muted-foreground">
            <span
              className="size-[6px] rounded-full"
              style={{ background: 'hsl(var(--brand))', animation: 'live-pulse 1.6s infinite' }}
            />
            <span className="hidden sm:inline">LIVE</span>
          </span>
        )}
      </div>
      {/* mobile: compact numeric value (the dot-matrix is too tall for a 3-up row) */}
      <div className="font-mono text-[20px] font-semibold leading-none tracking-[-0.5px] sm:hidden">{value}</div>
      {/* desktop: dot-matrix value + sub label */}
      <div className="hidden items-end gap-[10px] sm:flex">
        {isNumeric(value) ? (
          <span className="text-foreground">
            <DotMatrix text={value} />
          </span>
        ) : (
          <div className="font-mono text-[34px] font-semibold leading-none tracking-[-1px]">{value}</div>
        )}
        <span className="mb-[2px] font-mono text-[10px] uppercase tracking-[0.5px] text-muted-foreground">{sub}</span>
      </div>
    </div>
  )
}

export default Boxes
