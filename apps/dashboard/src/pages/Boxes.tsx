import { ResourceFilter } from '@/components/ResourceLayout'
/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationSuspendedError } from '@/api/errors'
import { AsciiButton, StatCard } from '@/components/ascii'
import { CreateBoxDialog } from '@/components/Box/CreateBoxDialog'
import { BoxTable } from '@/components/BoxTable'
import { Plus } from '@/components/ui/icon'

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
import { getLocalStorageItem } from '@/lib/local-storage'
import {
  mergeOnboardingProgress,
  ONBOARDING_PROGRESS_EVENT,
  readOnboardingProgress,
  type OnboardingProgress,
} from '@/lib/onboarding-progress'
import { shouldAutoOpenOnboarding } from '@/lib/onboarding-visibility'
import { useApiKeysQuery } from '@/hooks/queries/useApiKeysQuery'
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
import { generatePath, useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

// Below this many boxes the table already provides the fleet summary.
const FLEET_THRESHOLD = 10

/** Lists and filters paginated Boxes, with organization-wide fleet counts and permission-gated lifecycle actions. */
const Boxes: React.FC = () => {
  const api = useApi()
  const { boxApi } = api
  const { user } = useAuth()
  const userId = user?.profile.sub
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { notificationSocket } = useNotificationSocket()
  const config = useConfig()
  const queryClient = useQueryClient()
  const { selectedOrganization, authenticatedUserOrganizationMember, authenticatedUserHasPermission } =
    useSelectedOrganization()
  const [createBoxOpen, setCreateBoxOpen] = useState(false)
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
  // Zero boxes and no filter narrowing the view: nothing to list, so the page
  // leads with how boxes get made.

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
            <Button variant="secondary" onClick={() => navigate(RoutePath.BILLING)}>
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

  // Onboarding auto-open. Deliberately placed below the fleet-count query: the local "skip"
  // flag only remembers one browser, so whether this account is actually new is decided by
  // account state (an API key or any box), which follows the user to a new browser or device.
  const apiKeysQuery = useApiKeysQuery(orgId)

  useEffect(() => {
    if (!selectedOrganization || !userId) {
      return
    }

    const skipOnboardingKey = `${LocalStorageKey.SkipOnboardingPrefix}${userId}`

    const requestedByUrl = searchParams.get('onboarding') === '1'
    if (
      shouldAutoOpenOnboarding({
        requestedByUrl,
        canCompleteWelcome: authenticatedUserOrganizationMember?.role === OrganizationUserRoleEnum.OWNER,
        dismissedInThisBrowser: getLocalStorageItem(skipOnboardingKey) === 'true',
        accountStateLoaded: apiKeysQuery.isSuccess && totalBoxesQuery.isSuccess,
        hasApiKeys: (apiKeysQuery.data?.length ?? 0) > 0,
        hasBoxes: (totalBoxesQuery.data ?? 0) > 0,
      })
    ) {
      navigate(requestedByUrl ? RoutePath.QUICKSTART : RoutePath.WELCOME, { replace: true })
    }
  }, [
    navigate,
    apiKeysQuery.data,
    apiKeysQuery.isSuccess,
    authenticatedUserOrganizationMember?.role,
    searchParams,
    selectedOrganization,
    totalBoxesQuery.data,
    totalBoxesQuery.isSuccess,
    userId,
  ])

  const totalBoxesDisplay = totalBoxesQuery.data != null ? totalBoxesQuery.data.toLocaleString('en-US') : '…'
  const runningBoxesDisplay = runningBoxesQuery.data != null ? runningBoxesQuery.data.toLocaleString('en-US') : '…'
  const stoppedBoxesDisplay = stoppedBoxesQuery.data != null ? stoppedBoxesQuery.data.toLocaleString('en-US') : '…'

  return (
    <div className="page-container flex h-[calc(100svh-60px)] min-h-0 flex-col pt-5 lg:pt-[26px]">
      {/* header */}
      <div className="resource-page-header flex items-end justify-between">
        <div>
          <h1 className="font-display text-page font-semibold text-foreground">Boxes</h1>
          <p className="mt-2 text-body leading-relaxed text-muted-foreground">
            Create Boxes to run agentic workloads and apps in isolated environments.{' '}
            <button
              type="button"
              onClick={() => navigate(RoutePath.QUICKSTART)}
              className="ml-2 inline text-foreground underline underline-offset-4 hover:text-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
            >
              First time here? Follow Quickstart →
            </button>
          </p>
        </div>
      </div>

      {(totalBoxesQuery.data ?? 0) >= FLEET_THRESHOLD && (
        <div className="mb-6 grid shrink-0 grid-cols-3 gap-3" aria-label="Boxes overview">
          <StatCard label="total boxes" value={totalBoxesDisplay} sub="all states" />
          <StatCard label="running boxes" value={runningBoxesDisplay} sub="active now" live />
          <StatCard label="stopped boxes" value={stoppedBoxesDisplay} sub="idle" />
        </div>
      )}

      {/* toolbar */}
      <div className="resource-toolbar">
        <ResourceFilter
          label="Filter boxes"
          value={filters.idOrName ?? ''}
          onChange={(value) => handleFiltersChange({ ...filters, idOrName: value || undefined })}
          count={boxesDataIsPlaceholderData ? '—' : (boxesData?.total ?? '—')}
        />
        <div className="flex-1" />
        {authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_BOXES) && (
          <CreateBoxDialog
            open={createBoxOpen}
            onOpenChange={setCreateBoxOpen}
            onCreated={() => {
              updateOnboardingProgress({ boxCreated: true })
            }}
          >
            <AsciiButton variant="primary" className="h-11 sm:h-9" type="button" title="New Box">
              <Plus className="size-3.5" strokeWidth={2.4} />
              New Box
            </AsciiButton>
          </CreateBoxDialog>
        )}
      </div>

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
          onOpenQuickstart={() => navigate(RoutePath.QUICKSTART)}
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

export default Boxes
