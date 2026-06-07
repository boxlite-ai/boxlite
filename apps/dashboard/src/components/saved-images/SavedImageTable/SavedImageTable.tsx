/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useCommandPaletteActions } from '@/components/CommandPalette'
import { useCommandPaletteAnalytics } from '@/hooks/useCommandPaletteAnalytics'
import { SelectionToast } from '@/components/SelectionToast'
import { Skeleton } from '@/components/ui/skeleton'
import { SavedImageSorting } from '@/hooks/queries/useSavedImagesPageQuery'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { cn } from '@/lib/utils'
import { OrganizationRolePermissionsEnum, SavedImageDto, SavedImageState } from '@boxlite-ai/api-client'
import { flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table'
import { Box } from 'lucide-react'
import { AnimatePresence } from 'motion/react'
import { useCallback, useMemo, useState } from 'react'
import { Pagination } from '../../Pagination'
import { TableEmptyState } from '../../TableEmptyState'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../ui/table'
import { SavedImageBulkAction, SavedImageBulkActionAlertDialog } from './BulkActionAlertDialog'
import { columns } from './columns'
import {
  getSavedImageBulkActionCounts,
  isSavedImageActivatable,
  isSavedImageDeactivatable,
  isSavedImageDeletable,
  useSavedImagesCommands,
} from './useSavedImagesCommands'
import { convertApiSortingToTableSorting, convertTableSortingToApiSorting } from './utils'

interface DataTableProps {
  data: SavedImageDto[]
  loading: boolean
  loadingSavedImages: Record<string, boolean>
  getRegionName: (regionId: string) => string | undefined
  onDelete: (savedImage: SavedImageDto) => void
  onBulkDelete?: (savedImages: SavedImageDto[]) => void
  onBulkDeactivate?: (savedImages: SavedImageDto[]) => void
  onBulkActivate?: (savedImages: SavedImageDto[]) => void
  onActivate?: (savedImage: SavedImageDto) => void
  onDeactivate?: (savedImage: SavedImageDto) => void
  onCreateSavedImage?: () => void
  pagination: {
    pageIndex: number
    pageSize: number
  }
  pageCount: number
  totalItems: number
  onPaginationChange: (pagination: { pageIndex: number; pageSize: number }) => void
  sorting: SavedImageSorting
  onSortingChange: (sorting: SavedImageSorting) => void
}

export function SavedImageTable({
  data,
  loading,
  loadingSavedImages,
  getRegionName,
  onDelete,
  onActivate,
  onDeactivate,
  onCreateSavedImage,
  pagination,
  pageCount,
  totalItems,
  onBulkDelete,
  onBulkActivate,
  onBulkDeactivate,
  onPaginationChange,
  sorting,
  onSortingChange,
}: DataTableProps) {
  const { authenticatedUserHasPermission } = useSelectedOrganization()

  const writePermitted = useMemo(
    () => authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_SAVED_IMAGES),
    [authenticatedUserHasPermission],
  )

  const deletePermitted = useMemo(
    () => authenticatedUserHasPermission(OrganizationRolePermissionsEnum.DELETE_SAVED_IMAGES),
    [authenticatedUserHasPermission],
  )

  const tableSorting = useMemo(() => convertApiSortingToTableSorting(sorting), [sorting])

  const selectableCount = useMemo(() => {
    return data.filter(
      (savedImage) => !savedImage.general && !loadingSavedImages[savedImage.id] && savedImage.state !== SavedImageState.REMOVING,
    ).length
  }, [data, loadingSavedImages])

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    onSortingChange: (updater) => {
      const newTableSorting = typeof updater === 'function' ? updater(table.getState().sorting) : updater
      const newApiSorting = convertTableSortingToApiSorting(newTableSorting)
      onSortingChange(newApiSorting)
    },
    manualPagination: true,
    pageCount: pageCount || 1,
    onPaginationChange: pagination
      ? (updater) => {
          const newPagination = typeof updater === 'function' ? updater(table.getState().pagination) : updater
          onPaginationChange(newPagination)
        }
      : undefined,
    state: {
      sorting: tableSorting,
      pagination: {
        pageIndex: pagination?.pageIndex || 0,
        pageSize: pagination?.pageSize || 10,
      },
    },
    meta: {
      savedImage: {
        writePermitted,
        deletePermitted,
        loadingSavedImages,
        getRegionName,
        selectableCount,
        onDelete,
        loading,
        onActivate,
        onDeactivate,
      },
    },
    getRowId: (row) => row.id,
    enableRowSelection: deletePermitted,
  })

  const selectedRows = table.getSelectedRowModel().rows
  const hasSelection = selectedRows.length > 0

  const [pendingBulkAction, setPendingBulkAction] = useState<SavedImageBulkAction | null>(null)
  const selectedSavedImages = selectedRows.map((row) => row.original)

  const bulkActionCounts = useMemo(() => getSavedImageBulkActionCounts(selectedSavedImages), [selectedSavedImages])

  const handleBulkActionConfirm = () => {
    if (!pendingBulkAction) return

    const handlers: Record<SavedImageBulkAction, () => void> = {
      [SavedImageBulkAction.Delete]: () => {
        if (onBulkDelete) {
          onBulkDelete(selectedSavedImages.filter(isSavedImageDeletable))
        }
      },
      [SavedImageBulkAction.Deactivate]: () => {
        if (onBulkDeactivate) {
          onBulkDeactivate(selectedSavedImages.filter(isSavedImageDeactivatable))
        }
      },
    }

    handlers[pendingBulkAction]()
    setPendingBulkAction(null)
    table.toggleAllRowsSelected(false)
  }

  const toggleAllRowsSelected = useCallback(
    (selected: boolean) => {
      if (selected) {
        for (const row of table.getRowModel().rows) {
          const isGeneral = row.original.general
          const isLoading = loadingSavedImages[row.original.id]
          const isRemoving = row.original.state === SavedImageState.REMOVING
          if (!isGeneral && !isLoading && !isRemoving) {
            row.toggleSelected(true)
          }
        }
      } else {
        table.toggleAllRowsSelected(false)
      }
    },
    [table, loadingSavedImages],
  )

  useSavedImagesCommands({
    writePermitted,
    deletePermitted,
    selectedCount: selectedRows.length,
    totalCount: data.length,
    selectableCount,
    toggleAllRowsSelected,
    bulkActionCounts,
    onDelete: () => setPendingBulkAction(SavedImageBulkAction.Delete),
    onDeactivate: () => setPendingBulkAction(SavedImageBulkAction.Deactivate),
    onActivate: () => onBulkActivate?.(selectedSavedImages.filter(isSavedImageActivatable)),
    onCreateSavedImage: onCreateSavedImage,
  })

  const { setIsOpen } = useCommandPaletteActions()
  const { trackOpened } = useCommandPaletteAnalytics()
  const handleOpenCommandPalette = () => {
    trackOpened('savedImage_selection_toast')
    setIsOpen(true)
  }

  return (
    <div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  return (
                    <TableHead
                      key={header.id}
                      className={cn('px-2', header.column.getCanSort() && 'hover:bg-muted cursor-pointer')}
                    >
                      {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {loading ? (
              <>
                {Array.from(new Array(10)).map((_, i) => (
                  <TableRow key={i}>
                    {table.getVisibleLeafColumns().map((column, i, arr) =>
                      i === arr.length - 1 ? null : (
                        <TableCell key={column.id}>
                          <Skeleton className="h-4 w-10/12" />
                        </TableCell>
                      ),
                    )}
                  </TableRow>
                ))}
              </>
            ) : table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() ? 'selected' : undefined}
                  className={`${
                    loadingSavedImages[row.original.id] || row.original.state === SavedImageState.REMOVING
                      ? 'opacity-50 pointer-events-none'
                      : ''
                  } ${row.original.general ? 'pointer-events-none' : ''}`}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell className="px-2" key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableEmptyState
                colSpan={columns.length}
                message="No Images yet."
                icon={<Box className="w-8 h-8" />}
                description={
                  <div className="space-y-2">
                    <p>
                      Images are reusable, pre-configured Linux runtimes for your boxes. Use them to define language
                      runtimes, dependencies, and tools.
                    </p>
                    <p>
                      Create one from the Dashboard, CLI, or SDK to get started. <br />
                      <a
                        href="https://docs.boxlite.ai"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline font-medium"
                      >
                        Read the Images guide
                      </a>{' '}
                      to learn more.
                    </p>
                  </div>
                }
              />
            )}
          </TableBody>
        </Table>
      </div>
      <Pagination
        table={table}
        selectionEnabled={deletePermitted}
        entityName="Images"
        totalItems={totalItems}
        className="mt-4"
      />
      <AnimatePresence>
        {hasSelection && (
          <SelectionToast
            className="absolute bottom-5 left-1/2 -translate-x-1/2 z-50"
            selectedCount={selectedRows.length}
            onClearSelection={() => table.resetRowSelection()}
            onActionClick={handleOpenCommandPalette}
          />
        )}
      </AnimatePresence>

      <SavedImageBulkActionAlertDialog
        action={pendingBulkAction}
        count={
          pendingBulkAction
            ? {
                [SavedImageBulkAction.Delete]: bulkActionCounts.deletable,
                [SavedImageBulkAction.Deactivate]: bulkActionCounts.deactivatable,
              }[pendingBulkAction]
            : 0
        }
        onConfirm={handleBulkActionConfirm}
        onCancel={() => setPendingBulkAction(null)}
      />
    </div>
  )
}
