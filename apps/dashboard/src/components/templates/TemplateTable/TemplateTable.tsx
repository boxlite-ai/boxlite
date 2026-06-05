/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useCommandPaletteActions } from '@/components/CommandPalette'
import { useCommandPaletteAnalytics } from '@/hooks/useCommandPaletteAnalytics'
import { SelectionToast } from '@/components/SelectionToast'
import { Skeleton } from '@/components/ui/skeleton'
import { TemplateSorting } from '@/hooks/queries/useTemplatesPageQuery'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { cn } from '@/lib/utils'
import { OrganizationRolePermissionsEnum, BoxTemplateDto, BoxTemplateState } from '@boxlite-ai/api-client'
import { flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table'
import { Box } from 'lucide-react'
import { AnimatePresence } from 'motion/react'
import { useCallback, useMemo, useState } from 'react'
import { Pagination } from '../../Pagination'
import { TableEmptyState } from '../../TableEmptyState'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../ui/table'
import { TemplateBulkAction, TemplateBulkActionAlertDialog } from './BulkActionAlertDialog'
import { columns } from './columns'
import {
  getTemplateBulkActionCounts,
  isTemplateActivatable,
  isTemplateDeactivatable,
  isTemplateDeletable,
  useTemplatesCommands,
} from './useTemplatesCommands'
import { convertApiSortingToTableSorting, convertTableSortingToApiSorting } from './utils'

interface DataTableProps {
  data: BoxTemplateDto[]
  loading: boolean
  loadingTemplates: Record<string, boolean>
  getRegionName: (regionId: string) => string | undefined
  onDelete: (template: BoxTemplateDto) => void
  onBulkDelete?: (templates: BoxTemplateDto[]) => void
  onBulkDeactivate?: (templates: BoxTemplateDto[]) => void
  onBulkActivate?: (templates: BoxTemplateDto[]) => void
  onActivate?: (template: BoxTemplateDto) => void
  onDeactivate?: (template: BoxTemplateDto) => void
  onCreateTemplate?: () => void
  pagination: {
    pageIndex: number
    pageSize: number
  }
  pageCount: number
  totalItems: number
  onPaginationChange: (pagination: { pageIndex: number; pageSize: number }) => void
  sorting: TemplateSorting
  onSortingChange: (sorting: TemplateSorting) => void
}

export function TemplateTable({
  data,
  loading,
  loadingTemplates,
  getRegionName,
  onDelete,
  onActivate,
  onDeactivate,
  onCreateTemplate,
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
    () => authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_TEMPLATES),
    [authenticatedUserHasPermission],
  )

  const deletePermitted = useMemo(
    () => authenticatedUserHasPermission(OrganizationRolePermissionsEnum.DELETE_TEMPLATES),
    [authenticatedUserHasPermission],
  )

  const tableSorting = useMemo(() => convertApiSortingToTableSorting(sorting), [sorting])

  const selectableCount = useMemo(() => {
    return data.filter(
      (template) => !template.general && !loadingTemplates[template.id] && template.state !== BoxTemplateState.REMOVING,
    ).length
  }, [data, loadingTemplates])

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
      template: {
        writePermitted,
        deletePermitted,
        loadingTemplates,
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

  const [pendingBulkAction, setPendingBulkAction] = useState<TemplateBulkAction | null>(null)
  const selectedTemplates = selectedRows.map((row) => row.original)

  const bulkActionCounts = useMemo(() => getTemplateBulkActionCounts(selectedTemplates), [selectedTemplates])

  const handleBulkActionConfirm = () => {
    if (!pendingBulkAction) return

    const handlers: Record<TemplateBulkAction, () => void> = {
      [TemplateBulkAction.Delete]: () => {
        if (onBulkDelete) {
          onBulkDelete(selectedTemplates.filter(isTemplateDeletable))
        }
      },
      [TemplateBulkAction.Deactivate]: () => {
        if (onBulkDeactivate) {
          onBulkDeactivate(selectedTemplates.filter(isTemplateDeactivatable))
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
          const isLoading = loadingTemplates[row.original.id]
          const isRemoving = row.original.state === BoxTemplateState.REMOVING
          if (!isGeneral && !isLoading && !isRemoving) {
            row.toggleSelected(true)
          }
        }
      } else {
        table.toggleAllRowsSelected(false)
      }
    },
    [table, loadingTemplates],
  )

  useTemplatesCommands({
    writePermitted,
    deletePermitted,
    selectedCount: selectedRows.length,
    totalCount: data.length,
    selectableCount,
    toggleAllRowsSelected,
    bulkActionCounts,
    onDelete: () => setPendingBulkAction(TemplateBulkAction.Delete),
    onDeactivate: () => setPendingBulkAction(TemplateBulkAction.Deactivate),
    onActivate: () => onBulkActivate?.(selectedTemplates.filter(isTemplateActivatable)),
    onCreateTemplate: onCreateTemplate,
  })

  const { setIsOpen } = useCommandPaletteActions()
  const { trackOpened } = useCommandPaletteAnalytics()
  const handleOpenCommandPalette = () => {
    trackOpened('template_selection_toast')
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
                    loadingTemplates[row.original.id] || row.original.state === BoxTemplateState.REMOVING
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

      <TemplateBulkActionAlertDialog
        action={pendingBulkAction}
        count={
          pendingBulkAction
            ? {
                [TemplateBulkAction.Delete]: bulkActionCounts.deletable,
                [TemplateBulkAction.Deactivate]: bulkActionCounts.deactivatable,
              }[pendingBulkAction]
            : 0
        }
        onConfirm={handleBulkActionConfirm}
        onCancel={() => setPendingBulkAction(null)}
      />
    </div>
  )
}
