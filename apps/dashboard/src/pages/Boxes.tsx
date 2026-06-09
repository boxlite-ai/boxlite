/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationRolePermissionsEnum } from '@boxlite-ai/api-client'
import { OrganizationSuspendedError } from '@/api/errors'
import { PageContent, PageHeader, PageLayout, PageTitle } from '@/components/PageLayout'
import { CreateBoxSheet } from '@/components/Box/CreateBoxSheet'
import BoxDetailsSheet from '@/components/BoxDetailsSheet'
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
import { BOXLITE_DOCS_URL } from '@/constants/ExternalLinks'
import { DEFAULT_PAGE_SIZE } from '@/constants/Pagination'
import { LocalStorageKey } from '@/enums/LocalStorageKey'
import { RoutePath } from '@/enums/RoutePath'
import { SnapshotFilters, SnapshotQueryParams, useSnapshotsQuery } from '@/hooks/queries/useSnapshotsQuery'
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
import { formatDuration, pluralize } from '@/lib/utils'
import { OrganizationUserRoleEnum, Box, BoxDesiredState, BoxState, SshAccessDto } from '@boxlite-ai/api-client'
import { QueryKey, useQueryClient } from '@tanstack/react-query'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

const Boxes: React.FC = () => {
  const { boxApi, apiKeyApi, toolboxApi } = useApi()
  const { user } = useAuth()
  const navigate = useNavigate()
  const { notificationSocket } = useNotificationSocket()
  const config = useConfig()
  const queryClient = useQueryClient()
  const { selectedOrganization, authenticatedUserOrganizationMember, authenticatedUserHasPermission } =
    useSelectedOrganization()

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

  useEffect(() => {
    if (boxesDataError) {
      handleApiError(boxesDataError, 'Failed to fetch boxes')
    }
  }, [boxesDataError])

  const updateBoxInCache = useCallback(
    (boxId: string, updates: Partial<Box>) => {
      queryClient.setQueryData(queryKey, (oldData: any) => {
        if (!oldData) return oldData
        return {
          ...oldData,
          items: oldData.items.map((box: Box) => (box.id === boxId ? { ...box, ...updates } : box)),
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

  // Box Details Drawer

  const [selectedBox, setSelectedBox] = useState<Box | null>(null)
  const [showBoxDetails, setShowBoxDetails] = useState(false)

  useEffect(() => {
    if (!selectedBox || !boxesData?.items) {
      return
    }

    const selectedBoxInData = boxesData.items.find((s) => s.id === selectedBox.id)

    if (!selectedBoxInData) {
      setSelectedBox(null)
      setShowBoxDetails(false)
      return
    }

    if (selectedBoxInData !== selectedBox) {
      setSelectedBox(selectedBoxInData)
    }
  }, [boxesData?.items, selectedBox])

  const performBoxStateOptimisticUpdate = useCallback(
    (boxId: string, newState: BoxState) => {
      updateBoxInCache(boxId, { state: newState })

      if (selectedBox?.id === boxId) {
        setSelectedBox((prev) => (prev ? { ...prev, state: newState } : null))
      }
    },
    [updateBoxInCache, selectedBox?.id],
  )

  const revertBoxStateOptimisticUpdate = useCallback(
    (boxId: string, previousState?: BoxState) => {
      if (!previousState) {
        return
      }

      updateBoxInCache(boxId, { state: previousState })

      if (selectedBox?.id === boxId) {
        setSelectedBox((prev) => (prev ? { ...prev, state: previousState } : null))
      }
    },
    [updateBoxInCache, selectedBox?.id],
  )

  // SSH Access Dialogs

  const [showCreateSshDialog, setShowCreateSshDialog] = useState(false)
  const [showRevokeSshDialog, setShowRevokeSshDialog] = useState(false)
  const [sshAccess, setSshAccess] = useState<SshAccessDto | null>(null)
  const [sshExpiryMinutes, setSshExpiryMinutes] = useState<number>(60)
  const [revokeSshToken, setRevokeSshToken] = useState<string>('')
  const [sshBoxId, setSshBoxId] = useState<string>('')
  const [copied, setCopied] = useState<string | null>(null)

  // Snapshot Filter

  const [snapshotFilters, setSnapshotFilters] = useState<SnapshotFilters>({})

  const handleSnapshotFiltersChange = useCallback((filters: Partial<SnapshotFilters>) => {
    setSnapshotFilters((prev) => ({ ...prev, ...filters }))
  }, [])

  const snapshotsQueryParams = useMemo<SnapshotQueryParams>(
    () => ({
      page: 1,
      pageSize: 100,
      filters: snapshotFilters,
    }),
    [snapshotFilters],
  )

  const {
    data: snapshotsData,
    isLoading: snapshotsDataIsLoading,
    error: snapshotsDataError,
  } = useSnapshotsQuery(snapshotsQueryParams)

  const snapshotsDataHasMore = useMemo(() => {
    return snapshotsData && snapshotsData.totalPages > 1
  }, [snapshotsData])

  useEffect(() => {
    if (snapshotsDataError) {
      handleApiError(snapshotsDataError, 'Failed to fetch snapshots')
    }
  }, [snapshotsDataError])

  // Region Filter

  const { availableRegions: regionsData, loadingAvailableRegions: regionsDataIsLoading, getRegionName } = useRegions()

  // Subscribe to Box Events

  useEffect(() => {
    const handleBoxCreatedEvent = (box: Box) => {
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
        handleBoxCreatedEvent(data.box)
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

      performBoxStateOptimisticUpdate(data.box.id, updatedState)

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

      performBoxStateOptimisticUpdate(data.box.id, BoxState.DESTROYED)

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
    sorting.direction,
    sorting.field,
  ])

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

      if (selectedBox?.id === id) {
        setShowBoxDetails(false)
        setSelectedBox(null)
      }

      toast.success(`Deleting box with ID:  ${id}`)

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

  const handleArchive = async (id: string) => {
    setBoxIsLoading((prev) => ({ ...prev, [id]: true }))
    setBoxStateIsTransitioning((prev) => ({ ...prev, [id]: true }))

    const boxToArchive = boxesData?.items.find((s) => s.id === id)
    const previousState = boxToArchive?.state

    await cancelQueryRefetches(queryKey)
    performBoxStateOptimisticUpdate(id, BoxState.ARCHIVING)

    try {
      await boxApi.archiveBox(id, selectedOrganization?.id)
      toast.success(`Archiving box with ID: ${id}`)
      await markAllBoxQueriesAsStale()
    } catch (error) {
      handleApiError(error, 'Failed to archive box')
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

      return { successCount, failureCount }
    },
    [
      cancelQueryRefetches,
      queryKey,
      boxesData?.items,
      performBoxStateOptimisticUpdate,
      revertBoxStateOptimisticUpdate,
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

  const handleBulkArchive = (ids: string[]) =>
    executeBulkAction({
      ids,
      actionName: 'Archiving',
      optimisticState: BoxState.ARCHIVING,
      apiCall: (id) => boxApi.archiveBox(id, selectedOrganization?.id),
      toastMessages: {
        successTitle: `${pluralize(ids.length, 'box', 'boxes')} archived.`,
        errorTitle: `Failed to archive ${pluralize(ids.length, 'box', 'boxes')}.`,
        warningTitle: 'Failed to archive some boxes.',
        canceledTitle: 'Archive canceled.',
      },
    })

  const handleBulkDelete = async (ids: string[]) => {
    const selectedBoxInBulk = selectedBox && ids.includes(selectedBox.id)

    await executeBulkAction({
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

    if (selectedBoxInBulk) {
      setShowBoxDetails(false)
      setSelectedBox(null)
    }
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

  const getVncUrl = async (boxId: string): Promise<string | null> => {
    try {
      const portPreviewUrl = await getPortPreviewUrl(boxId, 6080)
      return portPreviewUrl + '/vnc.html'
    } catch (error) {
      handleApiError(error, 'Failed to construct VNC URL')
      return null
    }
  }

  const handleVnc = async (id: string) => {
    setBoxIsLoading((prev) => ({ ...prev, [id]: true }))

    // Notify user immediately that we're checking VNC status
    toast.info('Checking VNC desktop status...')

    try {
      // First, check if computer use is already started
      const statusResponse = await toolboxApi.getComputerUseStatusDeprecated(id, selectedOrganization?.id)
      const status = statusResponse.data.status

      // Check if computer use is active (all processes running)
      if (status === 'active') {
        const vncUrl = await getVncUrl(id)
        if (vncUrl) {
          window.open(vncUrl, '_blank')
          toast.success('Opening VNC desktop...')
        }
      } else {
        // Computer use is not active, try to start it
        try {
          await toolboxApi.startComputerUseDeprecated(id, selectedOrganization?.id)
          toast.success('Starting VNC desktop...')

          // Wait a moment for processes to start, then open VNC
          await new Promise((resolve) => setTimeout(resolve, 5000))

          try {
            const newStatusResponse = await toolboxApi.getComputerUseStatusDeprecated(id, selectedOrganization?.id)
            const newStatus = newStatusResponse.data.status

            if (newStatus === 'active') {
              const vncUrl = await getVncUrl(id)

              if (vncUrl) {
                window.open(vncUrl, '_blank')
                toast.success('VNC desktop is ready!', {
                  action: (
                    <Button variant="secondary" onClick={() => window.open(vncUrl, '_blank')}>
                      Open in new tab
                    </Button>
                  ),
                })
              }
            } else {
              toast.error(`VNC desktop failed to start. Status: ${newStatus}`)
            }
          } catch (error) {
            handleApiError(error, 'Failed to check VNC status after start')
          }
        } catch (startError: any) {
          // Check if this is a computer-use availability error
          const errorMessage = startError?.response?.data?.message || startError?.message || String(startError)

          if (errorMessage === 'Computer-use functionality is not available') {
            toast.error('Computer-use functionality is not available', {
              description: (
                <div>
                  <div>Computer-use dependencies are missing in the runtime environment.</div>
                  <div className="mt-2">
                    <a
                      href={`${BOXLITE_DOCS_URL}/getting-started/computer-use`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline"
                    >
                      See documentation on how to configure the runtime for computer-use
                    </a>
                  </div>
                </div>
              ),
            })
          } else {
            handleApiError(startError, 'Failed to start VNC desktop')
          }
        }
      }
    } catch (error) {
      handleApiError(error, 'Failed to check VNC status')
    } finally {
      setBoxIsLoading((prev) => ({ ...prev, [id]: false }))
    }
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

  // Redirect user to the onboarding page if they haven't created an api key yet
  // Perform only once per user

  useEffect(() => {
    const onboardIfNeeded = async () => {
      if (!selectedOrganization) {
        return
      }

      const skipOnboardingKey = `${LocalStorageKey.SkipOnboardingPrefix}${user?.profile.sub}`
      const shouldSkipOnboarding = getLocalStorageItem(skipOnboardingKey) === 'true'

      if (shouldSkipOnboarding) {
        return
      }

      try {
        const keys = (await apiKeyApi.listApiKeys(selectedOrganization.id)).data
        if (keys.length === 0) {
          setLocalStorageItem(skipOnboardingKey, 'true')
          navigate(RoutePath.ONBOARDING)
        } else {
          setLocalStorageItem(skipOnboardingKey, 'true')
        }
      } catch (error) {
        console.error('Failed to check if user needs onboarding', error)
      }
    }

    onboardIfNeeded()
  }, [navigate, user, selectedOrganization, apiKeyApi])

  return (
    <PageLayout>
      <PageHeader size="full">
        <PageTitle>Boxes</PageTitle>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {!boxesDataIsLoading && (!boxesData?.items || boxesData.items.length === 0) && (
            <>
              <Button variant="link" className="text-primary" onClick={() => navigate(RoutePath.ONBOARDING)} size="sm">
                Onboarding guide
              </Button>
              <Button variant="link" className="text-primary" asChild size="sm">
                <a href={BOXLITE_DOCS_URL} target="_blank" rel="noopener noreferrer" className="text-primary">
                  Docs
                </a>
              </Button>
            </>
          )}
          {authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_BOXES) && (
            <CreateBoxSheet triggerClassName="w-auto" />
          )}
        </div>
      </PageHeader>
      <PageContent size="full" className="min-h-0 flex-1 gap-3 max-h-[calc(100vh-65px)]">
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
          handleBulkArchive={handleBulkArchive}
          handleArchive={handleArchive}
          handleVnc={handleVnc}
          getWebTerminalUrl={getWebTerminalUrl}
          handleCreateSshAccess={openCreateSshDialog}
          handleRevokeSshAccess={openRevokeSshDialog}
          handleRefresh={handleRefresh}
          isRefreshing={boxDataIsRefreshing}
          data={boxesData?.items || []}
          loading={boxesDataIsLoading}
          snapshots={snapshotsData?.items || []}
          snapshotsDataIsLoading={snapshotsDataIsLoading}
          snapshotsDataHasMore={snapshotsDataHasMore}
          onChangeSnapshotSearchValue={(name?: string) => handleSnapshotFiltersChange({ name })}
          regionsData={regionsData || []}
          regionsDataIsLoading={regionsDataIsLoading}
          onRowClick={(box: Box) => {
            setSelectedBox(box)
            setShowBoxDetails(true)
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

        <BoxDetailsSheet
          box={selectedBox}
          open={showBoxDetails}
          onOpenChange={setShowBoxDetails}
          boxIsLoading={boxIsLoading}
          handleStart={handleStart}
          handleStop={handleStop}
          handleDelete={(id) => {
            setBoxToDelete(id)
            setShowDeleteDialog(true)
            setShowBoxDetails(false)
          }}
          handleArchive={handleArchive}
          getWebTerminalUrl={getWebTerminalUrl}
          writePermitted={authenticatedUserOrganizationMember?.role === OrganizationUserRoleEnum.OWNER}
          deletePermitted={authenticatedUserOrganizationMember?.role === OrganizationUserRoleEnum.OWNER}
          handleRecover={handleRecover}
          getRegionName={getRegionName}
        />
      </PageContent>
    </PageLayout>
  )
}

export default Boxes
