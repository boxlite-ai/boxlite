/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { PageContent, PageHeader, PageLayout, PageTitle } from '@/components/PageLayout'
import { CreateSavedImageDialog } from '@/components/saved-images/CreateSavedImageDialog'
import { SavedImageTable } from '@/components/saved-images/SavedImageTable'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DEFAULT_PAGE_SIZE } from '@/constants/Pagination'
import { useActivateSavedImageMutation } from '@/hooks/mutations/useActivateSavedImageMutation'
import { useDeactivateSavedImageMutation } from '@/hooks/mutations/useDeactivateSavedImageMutation'
import { useDeleteSavedImageMutation } from '@/hooks/mutations/useDeleteSavedImageMutation'
import { queryKeys } from '@/hooks/queries/queryKeys'
import {
  DEFAULT_SAVED_IMAGE_SORTING,
  SavedImageQueryParams,
  SavedImageSorting,
  useSavedImagesPageQuery,
  type PaginatedSavedImages,
} from '@/hooks/queries/useSavedImagesPageQuery'
import { useRegions } from '@/hooks/useRegions'
import { useSavedImageWsSync } from '@/hooks/useSavedImageWsSync'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { createBulkActionToast } from '@/lib/bulk-action-toast'
import { handleApiError } from '@/lib/error-handling'
import { pluralize } from '@/lib/utils'
import { OrganizationRolePermissionsEnum, SavedImageDto, SavedImageState } from '@boxlite-ai/api-client'
import { useQueryClient } from '@tanstack/react-query'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

const SavedImages: React.FC = () => {
  const queryClient = useQueryClient()
  useSavedImageWsSync()

  const { getRegionName } = useRegions()
  const [loadingSavedImages, setLoadingSavedImages] = useState<Record<string, boolean>>({})
  const [savedImageToDelete, setSavedImageToDelete] = useState<SavedImageDto | null>(null)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)

  const { selectedOrganization, authenticatedUserHasPermission } = useSelectedOrganization()
  const deleteSavedImageMutation = useDeleteSavedImageMutation({ invalidateOnSuccess: false })
  const activateSavedImageMutation = useActivateSavedImageMutation({ invalidateOnSuccess: false })
  const deactivateSavedImageMutation = useDeactivateSavedImageMutation({ invalidateOnSuccess: false })

  const [paginationParams, setPaginationParams] = useState({
    pageIndex: 0,
    pageSize: DEFAULT_PAGE_SIZE,
  })

  const [sorting, setSorting] = useState<SavedImageSorting>(DEFAULT_SAVED_IMAGE_SORTING)

  const queryParams = useMemo<SavedImageQueryParams>(
    () => ({
      page: paginationParams.pageIndex + 1,
      pageSize: paginationParams.pageSize,
      sorting,
    }),
    [paginationParams, sorting],
  )

  const savedImageListQueryKey = useMemo(
    () => queryKeys.savedImages.paginatedList(selectedOrganization?.id ?? ''),
    [selectedOrganization?.id],
  )

  const queryKey = useMemo(
    () => queryKeys.savedImages.paginatedList(selectedOrganization?.id ?? '', queryParams),
    [selectedOrganization?.id, queryParams],
  )

  const {
    data: savedImagesData,
    isLoading: savedImagesDataIsLoading,
    error: savedImagesDataError,
  } = useSavedImagesPageQuery(queryParams)

  useEffect(() => {
    if (savedImagesDataError) {
      handleApiError(savedImagesDataError, 'Failed to fetch images')
    }
  }, [savedImagesDataError])

  const updateSavedImageInCache = useCallback(
    (savedImageId: string, updates: Partial<SavedImageDto>) => {
      queryClient.setQueryData(queryKey, (oldData: PaginatedSavedImages | undefined) => {
        if (!oldData) return oldData
        return {
          ...oldData,
          items: oldData.items.map((savedImage) => (savedImage.id === savedImageId ? { ...savedImage, ...updates } : savedImage)),
        }
      })
    },
    [queryClient, queryKey],
  )

  const markAllSavedImageQueriesAsStale = useCallback(
    async (shouldRefetchActiveQueries = false) => {
      return queryClient.invalidateQueries({
        queryKey: savedImageListQueryKey,
        refetchType: shouldRefetchActiveQueries ? 'active' : 'none',
      })
    },
    [queryClient, savedImageListQueryKey],
  )

  const handlePaginationChange = useCallback(({ pageIndex, pageSize }: { pageIndex: number; pageSize: number }) => {
    setPaginationParams({ pageIndex, pageSize })
  }, [])

  const handleSortingChange = useCallback((newSorting: SavedImageSorting) => {
    setSorting(newSorting)
    setPaginationParams((prev) => ({ ...prev, pageIndex: 0 }))
  }, [])

  useEffect(() => {
    if (savedImagesData?.items.length === 0 && paginationParams.pageIndex > 0) {
      setPaginationParams((prev) => ({
        ...prev,
        pageIndex: prev.pageIndex - 1,
      }))
    }
  }, [savedImagesData?.items.length, paginationParams.pageIndex])

  const handleDelete = async (savedImage: SavedImageDto) => {
    setLoadingSavedImages((prev) => ({ ...prev, [savedImage.id]: true }))
    updateSavedImageInCache(savedImage.id, { state: SavedImageState.REMOVING })

    try {
      await deleteSavedImageMutation.mutateAsync({
        savedImageId: savedImage.id,
        organizationId: selectedOrganization?.id,
      })
      await markAllSavedImageQueriesAsStale(true)
      setSavedImageToDelete(null)
      setShowDeleteDialog(false)
      toast.success(`Deleting image ${savedImage.name}`)
    } catch (error) {
      handleApiError(error, 'Failed to delete image')
      updateSavedImageInCache(savedImage.id, { state: savedImage.state })
    } finally {
      setLoadingSavedImages((prev) => ({ ...prev, [savedImage.id]: false }))
    }
  }

  const handleActivate = async (savedImage: SavedImageDto) => {
    setLoadingSavedImages((prev) => ({ ...prev, [savedImage.id]: true }))
    updateSavedImageInCache(savedImage.id, { state: SavedImageState.PENDING })

    try {
      await activateSavedImageMutation.mutateAsync({
        savedImageId: savedImage.id,
        organizationId: selectedOrganization?.id,
      })
      await markAllSavedImageQueriesAsStale(true)
      toast.success(`Activating image ${savedImage.name}`)
    } catch (error) {
      handleApiError(error, 'Failed to activate image')
      updateSavedImageInCache(savedImage.id, { state: savedImage.state })
    } finally {
      setLoadingSavedImages((prev) => ({ ...prev, [savedImage.id]: false }))
    }
  }

  const handleDeactivate = async (savedImage: SavedImageDto) => {
    setLoadingSavedImages((prev) => ({ ...prev, [savedImage.id]: true }))
    updateSavedImageInCache(savedImage.id, { state: SavedImageState.INACTIVE })

    try {
      await deactivateSavedImageMutation.mutateAsync({
        savedImageId: savedImage.id,
        organizationId: selectedOrganization?.id,
      })
      await markAllSavedImageQueriesAsStale(true)
      toast.success(`Deactivating image ${savedImage.name}`)
    } catch (error) {
      handleApiError(error, 'Failed to deactivate image')
      updateSavedImageInCache(savedImage.id, { state: savedImage.state })
    } finally {
      setLoadingSavedImages((prev) => ({ ...prev, [savedImage.id]: false }))
    }
  }

  const writePermitted = useMemo(
    () => authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_SAVED_IMAGES),
    [authenticatedUserHasPermission],
  )

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
      optimisticState: SavedImageState
      apiCall: (id: string) => Promise<unknown>
      toastMessages: {
        successTitle: string
        errorTitle: string
        warningTitle: string
        canceledTitle: string
      }
    }) => {
      const previousStatesById = new Map((savedImagesData?.items ?? []).map((savedImage) => [savedImage.id, savedImage.state]))

      let isCancelled = false
      let processedCount = 0
      let successCount = 0
      let failureCount = 0

      const totalLabel = pluralize(ids.length, 'image', 'images')
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

          setLoadingSavedImages((prev) => ({ ...prev, [id]: true }))
          updateSavedImageInCache(id, { state: optimisticState })

          try {
            await apiCall(id)
            successCount += 1
          } catch (error) {
            failureCount += 1
            updateSavedImageInCache(id, { state: previousStatesById.get(id) })
            console.error(`${actionName} image failed`, id, error)
          } finally {
            setLoadingSavedImages((prev) => ({ ...prev, [id]: false }))
          }
        }

        await markAllSavedImageQueriesAsStale(true)
        bulkToast.result({ successCount, failureCount }, toastMessages)
      } catch (error) {
        console.error(`${actionName} images failed`, error)
        bulkToast.error(`${actionName} images failed.`)
      }

      return { successCount, failureCount }
    },
    [savedImagesData?.items, updateSavedImageInCache, markAllSavedImageQueriesAsStale],
  )

  const handleBulkDelete = (savedImages: SavedImageDto[]) =>
    executeBulkAction({
      ids: savedImages.map((s) => s.id),
      actionName: 'Deleting',
      optimisticState: SavedImageState.REMOVING,
      apiCall: (id) =>
        deleteSavedImageMutation.mutateAsync({
          savedImageId: id,
          organizationId: selectedOrganization?.id,
        }),
      toastMessages: {
        successTitle: `${pluralize(savedImages.length, 'Image', 'Images')} deleted.`,
        errorTitle: `Failed to delete ${pluralize(savedImages.length, 'image', 'images')}.`,
        warningTitle: 'Failed to delete some images.',
        canceledTitle: 'Delete canceled.',
      },
    })

  const handleBulkDeactivate = (savedImages: SavedImageDto[]) =>
    executeBulkAction({
      ids: savedImages.map((s) => s.id),
      actionName: 'Deactivating',
      optimisticState: SavedImageState.INACTIVE,
      apiCall: (id) =>
        deactivateSavedImageMutation.mutateAsync({
          savedImageId: id,
          organizationId: selectedOrganization?.id,
        }),
      toastMessages: {
        successTitle: `${pluralize(savedImages.length, 'Image', 'Images')} deactivated.`,
        errorTitle: `Failed to deactivate ${pluralize(savedImages.length, 'image', 'images')}.`,
        warningTitle: 'Failed to deactivate some images.',
        canceledTitle: 'Deactivate canceled.',
      },
    })

  const handleBulkActivate = (savedImages: SavedImageDto[]) =>
    executeBulkAction({
      ids: savedImages.map((s) => s.id),
      actionName: 'Activating',
      optimisticState: SavedImageState.ACTIVE,
      apiCall: (id) =>
        activateSavedImageMutation.mutateAsync({
          savedImageId: id,
          organizationId: selectedOrganization?.id,
        }),
      toastMessages: {
        successTitle: `${pluralize(savedImages.length, 'Image', 'Images')} activated.`,
        errorTitle: `Failed to activate ${pluralize(savedImages.length, 'image', 'images')}.`,
        warningTitle: 'Failed to activate some images.',
        canceledTitle: 'Activate canceled.',
      },
    })

  const dialogRef = useRef<{ open: () => void }>(null)

  const handleCreateSavedImage = () => {
    dialogRef.current?.open()
  }

  return (
    <PageLayout>
      <PageHeader size="full">
        <PageTitle>Images</PageTitle>
        {writePermitted && <CreateSavedImageDialog className="ml-auto" ref={dialogRef} />}
      </PageHeader>

      <PageContent size="full">
        <SavedImageTable
          data={savedImagesData?.items ?? []}
          loading={savedImagesDataIsLoading}
          loadingSavedImages={loadingSavedImages}
          getRegionName={getRegionName}
          onDelete={(savedImage) => {
            setSavedImageToDelete(savedImage)
            setShowDeleteDialog(true)
          }}
          onBulkDelete={handleBulkDelete}
          onBulkDeactivate={handleBulkDeactivate}
          onBulkActivate={handleBulkActivate}
          onActivate={handleActivate}
          onDeactivate={handleDeactivate}
          onCreateSavedImage={handleCreateSavedImage}
          pageCount={savedImagesData?.totalPages ?? 0}
          totalItems={savedImagesData?.total ?? 0}
          onPaginationChange={handlePaginationChange}
          pagination={{
            pageIndex: paginationParams.pageIndex,
            pageSize: paginationParams.pageSize,
          }}
          sorting={sorting}
          onSortingChange={handleSortingChange}
        />

        {savedImageToDelete && (
          <Dialog
            open={showDeleteDialog}
            onOpenChange={(isOpen) => {
              setShowDeleteDialog(isOpen)
              if (!isOpen) {
                setSavedImageToDelete(null)
              }
            }}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Confirm Image Deletion</DialogTitle>
                <DialogDescription>
                  Are you sure you want to delete this image? This action cannot be undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button" variant="secondary">
                    Cancel
                  </Button>
                </DialogClose>
                <Button
                  variant="destructive"
                  onClick={() => handleDelete(savedImageToDelete)}
                  disabled={loadingSavedImages[savedImageToDelete.id]}
                >
                  {loadingSavedImages[savedImageToDelete.id] ? 'Deleting...' : 'Delete'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </PageContent>
    </PageLayout>
  )
}

export default SavedImages
