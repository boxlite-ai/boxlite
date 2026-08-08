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

// A phone fits about three columns. Keep the ones a reader acts on — which
// invoice, how much, and whether it is paid — and bring the rest back at sm.
const NARROW_SCREEN_HIDDEN = new Set(['issuingDate', 'paymentDueDate', 'type'])

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
  onViewInvoice,
  onVoidInvoice,
  onRowClick,
  onPayInvoice,
}: InvoicesTableProps) {
  const isNarrow = useMatchMedia(NARROW_SCREEN)
  const { table } = useInvoicesTable({
    data,
    pagination,
    pageCount,
    onPaginationChange,
    onViewInvoice,
    onVoidInvoice,
    onPayInvoice,
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
              <TableRow
                key={row.id}
                className={`transition-colors duration-300 ${onRowClick ? 'cursor-pointer' : ''}`}
                onClick={() => onRowClick?.(row.original)}
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell
                    key={cell.id}
                    onClick={(e) => {
                      if (cell.column.id === 'actions') {
                        e.stopPropagation()
                      }
                    }}
                    className={cn(
                      'border-b border-border font-mono text-[12px]',
                      NARROW_SCREEN_HIDDEN.has(cell.column.id) && 'hidden sm:table-cell',
                    )}
                    // The four columns kept below sm carry 440px of minimums
                    // (100 default + 120 + 120 + 100) against a phone's ~322px of
                    // content width, which pushed the sticky actions column off
                    // screen. Below sm they size to their content instead.
                    style={
                      isNarrow
                        ? undefined
                        : {
                            width: cell.column.id === 'number' ? '20%' : 'auto',
                            maxWidth: cell.column.getSize() + 80,
                            minWidth: cell.column.getSize(),
                          }
                    }
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
              message="No invoices yet."
              icon={<FileText className="w-8 h-8" />}
              description={
                <div className="space-y-2">
                  <p>Invoices will appear here once they are generated.</p>
                </div>
              }
            />
          )}
        </TableBody>
      </Table>

      <div className="flex items-center justify-end">
        <Pagination className="pb-2 pt-6" table={table} entityName="Invoices" totalItems={totalItems} />
      </div>
    </>
  )
}
