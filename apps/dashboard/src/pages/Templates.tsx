/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { PageContent, PageHeader, PageLayout, PageTitle } from '@/components/PageLayout'
import { CreateTemplateDialog } from '@/components/templates/CreateTemplateDialog'
import { TemplateTable } from '@/components/templates/TemplateTable'
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
import { useActivateTemplateMutation } from '@/hooks/mutations/useActivateTemplateMutation'
import { useDeactivateTemplateMutation } from '@/hooks/mutations/useDeactivateTemplateMutation'
import { useDeleteTemplateMutation } from '@/hooks/mutations/useDeleteTemplateMutation'
import { queryKeys } from '@/hooks/queries/queryKeys'
import {
  DEFAULT_TEMPLATE_SORTING,
  TemplateQueryParams,
  TemplateSorting,
  useTemplatesPageQuery,
  type PaginatedBoxTemplates,
} from '@/hooks/queries/useTemplatesPageQuery'
import { useRegions } from '@/hooks/useRegions'
import { useTemplateWsSync } from '@/hooks/useTemplateWsSync'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { createBulkActionToast } from '@/lib/bulk-action-toast'
import { handleApiError } from '@/lib/error-handling'
import { pluralize } from '@/lib/utils'
import { OrganizationRolePermissionsEnum, BoxTemplateDto, BoxTemplateState } from '@boxlite-ai/api-client'
import { useQueryClient } from '@tanstack/react-query'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

const Templates: React.FC = () => {
  const queryClient = useQueryClient()
  useTemplateWsSync()

  const { getRegionName } = useRegions()
  const [loadingTemplates, setLoadingTemplates] = useState<Record<string, boolean>>({})
  const [templateToDelete, setTemplateToDelete] = useState<BoxTemplateDto | null>(null)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)

  const { selectedOrganization, authenticatedUserHasPermission } = useSelectedOrganization()
  const deleteTemplateMutation = useDeleteTemplateMutation({ invalidateOnSuccess: false })
  const activateTemplateMutation = useActivateTemplateMutation({ invalidateOnSuccess: false })
  const deactivateTemplateMutation = useDeactivateTemplateMutation({ invalidateOnSuccess: false })

  const [paginationParams, setPaginationParams] = useState({
    pageIndex: 0,
    pageSize: DEFAULT_PAGE_SIZE,
  })

  const [sorting, setSorting] = useState<TemplateSorting>(DEFAULT_TEMPLATE_SORTING)

  const queryParams = useMemo<TemplateQueryParams>(
    () => ({
      page: paginationParams.pageIndex + 1,
      pageSize: paginationParams.pageSize,
      sorting,
    }),
    [paginationParams, sorting],
  )

  const templateListQueryKey = useMemo(
    () => queryKeys.templates.paginatedList(selectedOrganization?.id ?? ''),
    [selectedOrganization?.id],
  )

  const queryKey = useMemo(
    () => queryKeys.templates.paginatedList(selectedOrganization?.id ?? '', queryParams),
    [selectedOrganization?.id, queryParams],
  )

  const {
    data: templatesData,
    isLoading: templatesDataIsLoading,
    error: templatesDataError,
  } = useTemplatesPageQuery(queryParams)

  useEffect(() => {
    if (templatesDataError) {
      handleApiError(templatesDataError, 'Failed to fetch images')
    }
  }, [templatesDataError])

  const updateTemplateInCache = useCallback(
    (templateId: string, updates: Partial<BoxTemplateDto>) => {
      queryClient.setQueryData(queryKey, (oldData: PaginatedBoxTemplates | undefined) => {
        if (!oldData) return oldData
        return {
          ...oldData,
          items: oldData.items.map((template) => (template.id === templateId ? { ...template, ...updates } : template)),
        }
      })
    },
    [queryClient, queryKey],
  )

  const markAllTemplateQueriesAsStale = useCallback(
    async (shouldRefetchActiveQueries = false) => {
      return queryClient.invalidateQueries({
        queryKey: templateListQueryKey,
        refetchType: shouldRefetchActiveQueries ? 'active' : 'none',
      })
    },
    [queryClient, templateListQueryKey],
  )

  const handlePaginationChange = useCallback(({ pageIndex, pageSize }: { pageIndex: number; pageSize: number }) => {
    setPaginationParams({ pageIndex, pageSize })
  }, [])

  const handleSortingChange = useCallback((newSorting: TemplateSorting) => {
    setSorting(newSorting)
    setPaginationParams((prev) => ({ ...prev, pageIndex: 0 }))
  }, [])

  useEffect(() => {
    if (templatesData?.items.length === 0 && paginationParams.pageIndex > 0) {
      setPaginationParams((prev) => ({
        ...prev,
        pageIndex: prev.pageIndex - 1,
      }))
    }
  }, [templatesData?.items.length, paginationParams.pageIndex])

  const handleDelete = async (template: BoxTemplateDto) => {
    setLoadingTemplates((prev) => ({ ...prev, [template.id]: true }))
    updateTemplateInCache(template.id, { state: BoxTemplateState.REMOVING })

    try {
      await deleteTemplateMutation.mutateAsync({
        templateId: template.id,
        organizationId: selectedOrganization?.id,
      })
      await markAllTemplateQueriesAsStale(true)
      setTemplateToDelete(null)
      setShowDeleteDialog(false)
      toast.success(`Deleting image ${template.name}`)
    } catch (error) {
      handleApiError(error, 'Failed to delete image')
      updateTemplateInCache(template.id, { state: template.state })
    } finally {
      setLoadingTemplates((prev) => ({ ...prev, [template.id]: false }))
    }
  }

  const handleActivate = async (template: BoxTemplateDto) => {
    setLoadingTemplates((prev) => ({ ...prev, [template.id]: true }))
    updateTemplateInCache(template.id, { state: BoxTemplateState.PENDING })

    try {
      await activateTemplateMutation.mutateAsync({
        templateId: template.id,
        organizationId: selectedOrganization?.id,
      })
      await markAllTemplateQueriesAsStale(true)
      toast.success(`Activating image ${template.name}`)
    } catch (error) {
      handleApiError(error, 'Failed to activate image')
      updateTemplateInCache(template.id, { state: template.state })
    } finally {
      setLoadingTemplates((prev) => ({ ...prev, [template.id]: false }))
    }
  }

  const handleDeactivate = async (template: BoxTemplateDto) => {
    setLoadingTemplates((prev) => ({ ...prev, [template.id]: true }))
    updateTemplateInCache(template.id, { state: BoxTemplateState.INACTIVE })

    try {
      await deactivateTemplateMutation.mutateAsync({
        templateId: template.id,
        organizationId: selectedOrganization?.id,
      })
      await markAllTemplateQueriesAsStale(true)
      toast.success(`Deactivating image ${template.name}`)
    } catch (error) {
      handleApiError(error, 'Failed to deactivate image')
      updateTemplateInCache(template.id, { state: template.state })
    } finally {
      setLoadingTemplates((prev) => ({ ...prev, [template.id]: false }))
    }
  }

  const writePermitted = useMemo(
    () => authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_TEMPLATES),
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
      optimisticState: BoxTemplateState
      apiCall: (id: string) => Promise<unknown>
      toastMessages: {
        successTitle: string
        errorTitle: string
        warningTitle: string
        canceledTitle: string
      }
    }) => {
      const previousStatesById = new Map((templatesData?.items ?? []).map((template) => [template.id, template.state]))

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

          setLoadingTemplates((prev) => ({ ...prev, [id]: true }))
          updateTemplateInCache(id, { state: optimisticState })

          try {
            await apiCall(id)
            successCount += 1
          } catch (error) {
            failureCount += 1
            updateTemplateInCache(id, { state: previousStatesById.get(id) })
            console.error(`${actionName} image failed`, id, error)
          } finally {
            setLoadingTemplates((prev) => ({ ...prev, [id]: false }))
          }
        }

        await markAllTemplateQueriesAsStale(true)
        bulkToast.result({ successCount, failureCount }, toastMessages)
      } catch (error) {
        console.error(`${actionName} images failed`, error)
        bulkToast.error(`${actionName} images failed.`)
      }

      return { successCount, failureCount }
    },
    [templatesData?.items, updateTemplateInCache, markAllTemplateQueriesAsStale],
  )

  const handleBulkDelete = (templates: BoxTemplateDto[]) =>
    executeBulkAction({
      ids: templates.map((s) => s.id),
      actionName: 'Deleting',
      optimisticState: BoxTemplateState.REMOVING,
      apiCall: (id) =>
        deleteTemplateMutation.mutateAsync({
          templateId: id,
          organizationId: selectedOrganization?.id,
        }),
      toastMessages: {
        successTitle: `${pluralize(templates.length, 'Image', 'Images')} deleted.`,
        errorTitle: `Failed to delete ${pluralize(templates.length, 'image', 'images')}.`,
        warningTitle: 'Failed to delete some images.',
        canceledTitle: 'Delete canceled.',
      },
    })

  const handleBulkDeactivate = (templates: BoxTemplateDto[]) =>
    executeBulkAction({
      ids: templates.map((s) => s.id),
      actionName: 'Deactivating',
      optimisticState: BoxTemplateState.INACTIVE,
      apiCall: (id) =>
        deactivateTemplateMutation.mutateAsync({
          templateId: id,
          organizationId: selectedOrganization?.id,
        }),
      toastMessages: {
        successTitle: `${pluralize(templates.length, 'Image', 'Images')} deactivated.`,
        errorTitle: `Failed to deactivate ${pluralize(templates.length, 'image', 'images')}.`,
        warningTitle: 'Failed to deactivate some images.',
        canceledTitle: 'Deactivate canceled.',
      },
    })

  const handleBulkActivate = (templates: BoxTemplateDto[]) =>
    executeBulkAction({
      ids: templates.map((s) => s.id),
      actionName: 'Activating',
      optimisticState: BoxTemplateState.ACTIVE,
      apiCall: (id) =>
        activateTemplateMutation.mutateAsync({
          templateId: id,
          organizationId: selectedOrganization?.id,
        }),
      toastMessages: {
        successTitle: `${pluralize(templates.length, 'Image', 'Images')} activated.`,
        errorTitle: `Failed to activate ${pluralize(templates.length, 'image', 'images')}.`,
        warningTitle: 'Failed to activate some images.',
        canceledTitle: 'Activate canceled.',
      },
    })

  const dialogRef = useRef<{ open: () => void }>(null)

  const handleCreateTemplate = () => {
    dialogRef.current?.open()
  }

  return (
    <PageLayout>
      <PageHeader size="full">
        <PageTitle>Images</PageTitle>
        {writePermitted && <CreateTemplateDialog className="ml-auto" ref={dialogRef} />}
      </PageHeader>

      <PageContent size="full">
        <TemplateTable
          data={templatesData?.items ?? []}
          loading={templatesDataIsLoading}
          loadingTemplates={loadingTemplates}
          getRegionName={getRegionName}
          onDelete={(template) => {
            setTemplateToDelete(template)
            setShowDeleteDialog(true)
          }}
          onBulkDelete={handleBulkDelete}
          onBulkDeactivate={handleBulkDeactivate}
          onBulkActivate={handleBulkActivate}
          onActivate={handleActivate}
          onDeactivate={handleDeactivate}
          onCreateTemplate={handleCreateTemplate}
          pageCount={templatesData?.totalPages ?? 0}
          totalItems={templatesData?.total ?? 0}
          onPaginationChange={handlePaginationChange}
          pagination={{
            pageIndex: paginationParams.pageIndex,
            pageSize: paginationParams.pageSize,
          }}
          sorting={sorting}
          onSortingChange={handleSortingChange}
        />

        {templateToDelete && (
          <Dialog
            open={showDeleteDialog}
            onOpenChange={(isOpen) => {
              setShowDeleteDialog(isOpen)
              if (!isOpen) {
                setTemplateToDelete(null)
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
                  onClick={() => handleDelete(templateToDelete)}
                  disabled={loadingTemplates[templateToDelete.id]}
                >
                  {loadingTemplates[templateToDelete.id] ? 'Deleting...' : 'Delete'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </PageContent>
    </PageLayout>
  )
}

export default Templates
