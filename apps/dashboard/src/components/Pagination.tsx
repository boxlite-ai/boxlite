/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Table } from '@tanstack/react-table'
import { ResourcePagination } from './ResourcePagination'
/** Adapts TanStack totals and page state to the shared resource footer. */
export function Pagination<TData>({
  table,
  selectionEnabled,
  className,
  entityName = 'items',
  totalItems,
}: {
  table: Table<TData>
  selectionEnabled?: boolean
  className?: string
  entityName?: string
  totalItems?: number
}) {
  const count = totalItems ?? table.getFilteredRowModel().rows.length
  const { pageIndex, pageSize } = table.getState().pagination
  const label = selectionEnabled
    ? `${table.getFilteredSelectedRowModel().rows.length} of ${count} selected`
    : `${entityName}: ${count}`
  return (
    <div className={className}>
      <ResourcePagination
        pageIndex={pageIndex}
        pageSize={pageSize}
        pageCount={table.getPageCount()}
        totalItems={count}
        itemRangeLabel={label}
        onPaginationChange={(next) => table.setPagination(next)}
      />
    </div>
  )
}
