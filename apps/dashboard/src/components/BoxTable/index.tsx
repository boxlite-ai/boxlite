/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RoutePath } from '@/enums/RoutePath'
import { useCommandPaletteAnalytics } from '@/hooks/useCommandPaletteAnalytics'
import { useIsCompactScreen } from '@/hooks/use-mobile'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { cn } from '@/lib/utils'
import {
  filterArchivable,
  filterDeletable,
  filterStartable,
  filterStoppable,
  getBulkActionCounts,
} from '@/lib/utils/box'
import { OrganizationRolePermissionsEnum, Box, BoxState } from '@boxlite-ai/api-client'
import { flexRender } from '@tanstack/react-table'
import { Container } from 'lucide-react'
import { AnimatePresence } from 'motion/react'
import { type ReactNode, useCallback, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useCommandPaletteActions } from '../CommandPalette'
import { Pagination } from '../Pagination'
import { SelectionToast } from '../SelectionToast'
import { TableEmptyState } from '../TableEmptyState'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table'
import { BulkAction, BulkActionAlertDialog } from './BulkActionAlertDialog'
import { getBoxDisplayName, getBoxLastEvent } from './columns'
import { BoxState as BoxStateComponent } from './BoxState'
import { BoxTableActions } from './BoxTableActions'
import { BoxTableHeader } from './BoxTableHeader'
import { BoxTableProps } from './types'
import { useBoxCommands } from './useBoxCommands'
import { useBoxTable } from './useBoxTable'

function CompactBoxMeta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1 md:flex md:items-baseline md:gap-2 md:space-y-0">
      <div className="shrink-0 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
      <div className="min-w-0 truncate text-foreground">{children}</div>
    </div>
  )
}

export function BoxTable({
  data,
  boxIsLoading,
  boxStateIsTransitioning,
  loading,
  snapshots,
  snapshotsDataIsLoading,
  snapshotsDataHasMore,
  onChangeSnapshotSearchValue,
  regionsData,
  regionsDataIsLoading,
  getRegionName,
  handleStart,
  handleStop,
  handleDelete,
  handleBulkDelete,
  handleBulkStart,
  handleBulkStop,
  handleBulkArchive,
  handleArchive,
  handleVnc,
  getWebTerminalUrl,
  handleCreateSshAccess,
  handleRevokeSshAccess,
  handleScreenRecordings,
  handleRefresh,
  isRefreshing,
  onRowClick,
  pagination,
  pageCount,
  totalItems,
  onPaginationChange,
  sorting,
  onSortingChange,
  filters,
  onFiltersChange,
  handleRecover,
}: BoxTableProps) {
  const navigate = useNavigate()
  const isCompactScreen = useIsCompactScreen()
  const useCompactList = isCompactScreen
  const { authenticatedUserHasPermission } = useSelectedOrganization()
  const writePermitted = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_BOXES)
  const deletePermitted = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.DELETE_BOXES)

  const { table, regionOptions } = useBoxTable({
    data,
    boxIsLoading,
    writePermitted,
    deletePermitted,
    handleStart,
    handleStop,
    handleDelete,
    handleArchive,
    handleVnc,
    getWebTerminalUrl,
    handleCreateSshAccess,
    handleRevokeSshAccess,
    handleScreenRecordings,
    pagination,
    pageCount,
    onPaginationChange,
    sorting,
    onSortingChange,
    filters,
    onFiltersChange,
    regionsData,
    handleRecover,
    getRegionName,
  })

  const [pendingBulkAction, setPendingBulkAction] = useState<BulkAction | null>(null)

  const selectedRows = table.getRowModel().rows.filter((row) => row.getIsSelected())
  const hasSelection = selectedRows.length > 0
  const selectedCount = selectedRows.length
  const totalCount = table.getRowModel().rows.length
  const selectedBoxes: Box[] = selectedRows.map((row) => row.original)

  const bulkActionCounts = useMemo(() => getBulkActionCounts(selectedBoxes), [selectedBoxes])

  const handleBulkActionConfirm = () => {
    if (!pendingBulkAction) return

    const handlers: Record<BulkAction, () => void> = {
      [BulkAction.Delete]: () => handleBulkDelete(filterDeletable(selectedBoxes).map((s) => s.id)),
      [BulkAction.Start]: () => handleBulkStart(filterStartable(selectedBoxes).map((s) => s.id)),
      [BulkAction.Stop]: () => handleBulkStop(filterStoppable(selectedBoxes).map((s) => s.id)),
      [BulkAction.Archive]: () => handleBulkArchive(filterArchivable(selectedBoxes).map((s) => s.id)),
    }

    handlers[pendingBulkAction]()
    setPendingBulkAction(null)
    table.toggleAllRowsSelected(false)
  }

  const toggleAllRowsSelected = useCallback(
    (selected: boolean) => {
      if (selected) {
        for (const row of table.getRowModel().rows) {
          const selectDisabled = boxIsLoading[row.original.id] || row.original.state === BoxState.DESTROYED
          if (!selectDisabled) {
            row.toggleSelected(true)
          }
        }
      } else {
        table.toggleAllRowsSelected(selected)
      }
    },
    [boxIsLoading, table],
  )

  const selectableCount = useMemo(() => {
    return data.filter((box) => !boxIsLoading[box.id] && box.state !== BoxState.DESTROYED).length
  }, [boxIsLoading, data])

  useBoxCommands({
    writePermitted,
    deletePermitted,
    selectedCount,
    totalCount,
    selectableCount,
    toggleAllRowsSelected,
    bulkActionCounts,
    onDelete: () => setPendingBulkAction(BulkAction.Delete),
    onStart: () => setPendingBulkAction(BulkAction.Start),
    onStop: () => setPendingBulkAction(BulkAction.Stop),
    onArchive: () => setPendingBulkAction(BulkAction.Archive),
  })

  const { setIsOpen } = useCommandPaletteActions()
  const { trackOpened } = useCommandPaletteAnalytics()
  const handleOpenCommandPalette = () => {
    trackOpened('box_selection_toast')
    setIsOpen(true)
  }

  const handleOpenWebTerminal = useCallback(
    async (boxId: string) => {
      const url = await getWebTerminalUrl(boxId)
      if (url) {
        window.open(url, '_blank')
      }
    },
    [getWebTerminalUrl],
  )

  const emptyStateDescription = (
    <div className="space-y-2">
      <p>Spin up a Box to run code in an isolated environment.</p>
      <p>Use the BoxLite SDK or CLI to create one.</p>
      <p>
        <button onClick={() => navigate(RoutePath.ONBOARDING)} className="text-primary hover:underline font-medium">
          Check out the Onboarding guide
        </button>{' '}
        to learn more.
      </p>
    </div>
  )

  return (
    <>
      <BoxTableHeader
        table={table}
        regionOptions={regionOptions}
        regionsDataIsLoading={regionsDataIsLoading}
        snapshots={snapshots}
        snapshotsDataIsLoading={snapshotsDataIsLoading}
        snapshotsDataHasMore={snapshotsDataHasMore}
        onChangeSnapshotSearchValue={onChangeSnapshotSearchValue}
        onRefresh={handleRefresh}
        isRefreshing={isRefreshing}
      />

      {useCompactList ? (
        loading ? (
          <div className="rounded-sm border border-border px-4 py-8 text-sm text-muted-foreground">Loading...</div>
        ) : table.getRowModel().rows?.length ? (
          <div className="overflow-hidden rounded-sm border border-border bg-background/40">
            {table.getRowModel().rows.map((row) => {
              const box = row.original
              const lastEvent = getBoxLastEvent(box)
              const regionName = getRegionName(box.target) ?? box.target

              return (
                <div
                  key={row.id}
                  className={cn('border-b border-border last:border-b-0', {
                    'opacity-80 pointer-events-none': boxIsLoading[box.id] || box.state === BoxState.DESTROYED,
                    'bg-muted animate-pulse': boxStateIsTransitioning[box.id],
                  })}
                >
                  <div
                    role={onRowClick ? 'button' : undefined}
                    tabIndex={onRowClick ? 0 : undefined}
                    className={cn(
                      'w-full px-4 py-3 text-left transition-colors hover:bg-muted/30 focus-visible:bg-muted/40 focus-visible:outline-none',
                      {
                        'cursor-pointer': onRowClick,
                      },
                    )}
                    onClick={() => onRowClick?.(box)}
                    onKeyDown={(event) => {
                      if ((event.key === 'Enter' || event.key === ' ') && onRowClick) {
                        event.preventDefault()
                        onRowClick(box)
                      }
                    }}
                  >
                    <div className="grid w-full gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] md:items-center md:gap-4">
                      <div className="min-w-0 space-y-0.5">
                        <div className="truncate text-sm font-medium text-primary">{getBoxDisplayName(box)}</div>
                        <div className="truncate text-xs text-muted-foreground">{box.id}</div>
                      </div>

                      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs md:grid-cols-4 md:gap-x-4">
                        <CompactBoxMeta label="Snapshot">{box.snapshot || '-'}</CompactBoxMeta>
                        <CompactBoxMeta label="Region">{regionName}</CompactBoxMeta>
                        <CompactBoxMeta label="Resources">
                          {box.cpu} vCPU • {box.memory} GiB • {box.disk} GiB
                        </CompactBoxMeta>
                        <CompactBoxMeta label="Last">{lastEvent.relativeTimeString}</CompactBoxMeta>
                      </div>

                      <div className="flex items-center justify-between gap-3 md:justify-end">
                        <BoxStateComponent
                          state={box.state}
                          errorReason={box.errorReason}
                          recoverable={box.recoverable}
                          className="text-xs"
                        />
                        <BoxTableActions
                          box={box}
                          layout="mobile"
                          writePermitted={writePermitted}
                          deletePermitted={deletePermitted}
                          isLoading={boxIsLoading[box.id]}
                          onStart={handleStart}
                          onStop={handleStop}
                          onDelete={handleDelete}
                          onArchive={handleArchive}
                          onVnc={handleVnc}
                          onOpenWebTerminal={handleOpenWebTerminal}
                          onCreateSshAccess={handleCreateSshAccess}
                          onRevokeSshAccess={handleRevokeSshAccess}
                          onRecover={handleRecover}
                          onScreenRecordings={handleScreenRecordings}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="flex min-h-56 flex-col items-center justify-center rounded-sm border border-dashed border-border px-6 py-10 text-center">
            <Container className="mb-4 h-8 w-8 text-muted-foreground" />
            <div className="text-sm font-medium">No Boxes yet.</div>
            <div className="mt-2 max-w-sm text-sm text-muted-foreground">{emptyStateDescription}</div>
          </div>
        )
      ) : (
        <Table className="border-separate border-spacing-0" style={{ tableLayout: 'fixed', width: '100%' }}>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  return (
                    <TableHead
                      key={header.id}
                      data-state={header.column.getCanSort() && 'sortable'}
                      onClick={() =>
                        header.column.getCanSort() && header.column.toggleSorting(header.column.getIsSorted() === 'asc')
                      }
                      className={cn(
                        'sticky top-0 z-[3] border-b border-border',
                        header.column.getCanSort() ? 'hover:bg-muted cursor-pointer' : '',
                      )}
                      style={{
                        width: `${header.column.getSize()}px`,
                      }}
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
              <TableRow>
                <TableCell colSpan={table.getAllColumns().length} className="h-10 text-center">
                  Loading...
                </TableCell>
              </TableRow>
            ) : table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && 'selected'}
                  className={cn('group/table-row transition-all', {
                    'opacity-80 pointer-events-none':
                      boxIsLoading[row.original.id] || row.original.state === BoxState.DESTROYED,
                    'bg-muted animate-pulse': boxStateIsTransitioning[row.original.id],
                    'cursor-pointer': onRowClick,
                  })}
                  onClick={() => onRowClick?.(row.original)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      onClick={(e) => {
                        if (cell.column.id === 'select' || cell.column.id === 'actions') {
                          e.stopPropagation()
                        }
                      }}
                      className={cn('border-b border-border', {
                        'group-hover/table-row:underline': cell.column.id === 'name',
                      })}
                      style={{
                        width: `${cell.column.getSize()}px`,
                      }}
                      sticky={cell.column.id === 'actions' ? 'right' : undefined}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableEmptyState
                colSpan={table.getAllColumns().length}
                message="No Boxes yet."
                icon={<Container className="w-8 h-8" />}
                description={emptyStateDescription}
              />
            )}
          </TableBody>
        </Table>
      )}

      <div className="flex items-center justify-end relative">
        <Pagination className="pb-2 pt-4" table={table} entityName="Boxes" totalItems={totalItems} />

        <AnimatePresence>
          {!useCompactList && hasSelection && (
            <SelectionToast
              className="absolute bottom-5 left-1/2 -translate-x-1/2 z-50"
              selectedCount={selectedRows.length}
              onClearSelection={() => table.resetRowSelection()}
              onActionClick={handleOpenCommandPalette}
            />
          )}
        </AnimatePresence>
      </div>

      <BulkActionAlertDialog
        action={pendingBulkAction}
        count={
          pendingBulkAction
            ? {
                [BulkAction.Delete]: bulkActionCounts.deletable,
                [BulkAction.Start]: bulkActionCounts.startable,
                [BulkAction.Stop]: bulkActionCounts.stoppable,
                [BulkAction.Archive]: bulkActionCounts.archivable,
              }[pendingBulkAction]
            : 0
        }
        onConfirm={handleBulkActionConfirm}
        onCancel={() => setPendingBulkAction(null)}
      />
    </>
  )
}
