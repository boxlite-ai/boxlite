/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useIsCompactScreen, useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'
import { Table } from '@tanstack/react-table'
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'
import { PAGE_SIZE_OPTIONS } from '../constants/Pagination'
import { Button } from './ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

interface PaginationProps<TData> {
  table: Table<TData>
  selectionEnabled?: boolean
  className?: string
  entityName?: string
  totalItems?: number
}

export function Pagination<TData>({
  table,
  selectionEnabled,
  className,
  entityName,
  totalItems,
}: PaginationProps<TData>) {
  const isMobile = useIsMobile()
  const isCompactScreen = useIsCompactScreen()
  const itemCount = totalItems ?? table.getFilteredRowModel().rows.length
  const selectedItemCount = table.getFilteredSelectedRowModel().rows.length
  const pageNumber = table.getState().pagination.pageIndex + 1
  const pageTotal = table.getPageCount() || 1
  const itemCountLabel = selectionEnabled
    ? `${selectedItemCount} of ${itemCount} item(s) selected`
    : `${itemCount} total item(s)`
  const pageLabel = `Page ${pageNumber} of ${pageTotal}`

  if (isMobile) {
    return (
      <div className={cn('flex w-full flex-col gap-3', className)}>
        <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
          <div>{itemCountLabel}</div>
          <div className="shrink-0">{pageLabel}</div>
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            className="h-8 w-8 p-0"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            <span className="sr-only">Go to previous page</span>
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            className="h-8 w-8 p-0"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            <span className="sr-only">Go to next page</span>
            <ChevronRight />
          </Button>
        </div>
      </div>
    )
  }

  if (isCompactScreen) {
    return (
      <div className={cn('flex w-full items-center justify-between gap-4', className)}>
        <div className="text-sm text-muted-foreground">{itemCountLabel}</div>
        <div className="flex shrink-0 items-center gap-3">
          <div className="text-sm font-medium text-muted-foreground">{pageLabel}</div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              className="h-8 w-8 p-0"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
            >
              <span className="sr-only">Go to previous page</span>
              <ChevronLeft />
            </Button>
            <Button
              variant="outline"
              className="h-8 w-8 p-0"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
            >
              <span className="sr-only">Go to next page</span>
              <ChevronRight />
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={cn('flex w-full flex-col justify-between gap-2 sm:flex-row sm:items-center', className)}>
      <div className="flex items-center gap-4">
        <Select
          value={`${table.getState().pagination.pageSize}`}
          onValueChange={(value) => {
            table.setPageSize(Number(value))
          }}
        >
          <SelectTrigger className="h-8 w-[164px]">
            <SelectValue placeholder={table.getState().pagination.pageSize + 'per page'} />
          </SelectTrigger>
          <SelectContent side="top">
            {PAGE_SIZE_OPTIONS.map((pageSize) => (
              <SelectItem key={pageSize} value={`${pageSize}`}>
                {pageSize} per page
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {selectionEnabled ? (
          <div className="flex-1 text-sm text-muted-foreground">{itemCountLabel}.</div>
        ) : (
          <div className="flex-1 text-sm text-muted-foreground">{itemCountLabel}</div>
        )}
      </div>
      <div className="flex items-center gap-4">
        <div className="flex items-center justify-end text-sm font-medium text-muted-foreground">{pageLabel}</div>
        <div className="flex items-center space-x-2">
          <Button
            variant="outline"
            className="hidden h-8 w-8 p-0 lg:flex"
            onClick={() => table.setPageIndex(0)}
            disabled={!table.getCanPreviousPage()}
          >
            <span className="sr-only">Go to first page</span>
            <ChevronsLeft />
          </Button>
          <Button
            variant="outline"
            className="h-8 w-8 p-0"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            <span className="sr-only">Go to previous page</span>
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            className="h-8 w-8 p-0"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            <span className="sr-only">Go to next page</span>
            <ChevronRight />
          </Button>
          <Button
            variant="outline"
            className="hidden h-8 w-8 p-0 lg:flex"
            onClick={() => table.setPageIndex(table.getPageCount() - 1)}
            disabled={!table.getCanNextPage()}
          >
            <span className="sr-only">Go to last page</span>
            <ChevronsRight />
          </Button>
        </div>
      </div>
    </div>
  )
}
