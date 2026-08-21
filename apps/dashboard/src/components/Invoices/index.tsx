/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useMatchMedia } from '@/hooks/useMatchMedia'
import { cn } from '@/lib/utils'
import { flexRender } from '@tanstack/react-table'
import { FileText } from '@/components/ui/icon'
import { Pagination } from '../Pagination'
import { TableEmptyState } from '../TableEmptyState'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table'
import { InvoicesTableHeader } from './InvoicesTableHeader'
import { InvoicesTableProps } from './types'
import { useInvoicesTable } from './useInvoicesTable'

// A phone keeps the settlement id, charge date, cost and final state. The
// funding split returns at sm, where both amounts fit without crowding.
const NARROW_SCREEN_HIDDEN = new Set(['quotaCoveredCents', 'walletFundedCents'])

// Matches the `sm:` boundary the classes below use, so the JS and CSS halves of
// this layout never disagree in the 640-767px band.
const NARROW_SCREEN = '(max-width: 639px)'

export function InvoicesTable({
  data,
  pagination,
  totalItems,
  pageCount,
  onPaginationChange,
  loading,
}: InvoicesTableProps) {
  const isNarrow = useMatchMedia(NARROW_SCREEN)
  const { table } = useInvoicesTable({
    data,
    pagination,
    pageCount,
    onPaginationChange,
  })

  return (
    <>
      <InvoicesTableHeader table={table} />

      <Table className="border-separate border-spacing-0">
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
                      'sticky top-0 z-[3] border-b border-border font-mono text-[10px] uppercase tracking-[1.2px] text-muted-foreground',
                      header.column.getCanSort() ? 'hover:bg-muted cursor-pointer' : '',
                      NARROW_SCREEN_HIDDEN.has(header.column.id) && 'hidden sm:table-cell',
                    )}
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
              <TableRow key={row.id} className="transition-colors duration-300">
                {row.getVisibleCells().map((cell) => (
                  <TableCell
                    key={cell.id}
                    className={cn(
                      'border-b border-border font-mono text-[12px]',
                      NARROW_SCREEN_HIDDEN.has(cell.column.id) && 'hidden sm:table-cell',
                    )}
                    // Below sm, let the four essential columns size to their
                    // content instead of imposing desktop minimum widths.
                    style={
                      isNarrow
                        ? undefined
                        : {
                            width: cell.column.id === 'number' ? '20%' : 'auto',
                            maxWidth: cell.column.getSize() + 80,
                            minWidth: cell.column.getSize(),
                          }
                    }
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableEmptyState
              colSpan={table.getAllColumns().length}
              message="No usage settlements yet."
              icon={<FileText className="w-8 h-8" />}
              description={
                <div className="space-y-2">
                  <p>Settlements will appear here after metered usage is funded.</p>
                </div>
              }
            />
          )}
        </TableBody>
      </Table>

      <div className="flex items-center justify-end">
        <Pagination className="pb-2 pt-6" table={table} entityName="Settlements" totalItems={totalItems} />
      </div>
    </>
  )
}
