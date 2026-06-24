/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Box } from '@boxlite-ai/api-client'
import {
  useReactTable,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getPaginationRowModel,
  VisibilityState,
} from '@tanstack/react-table'
import { useMemo, useState, useEffect } from 'react'
import { getColumns } from './columns'
import {
  convertApiSortingToTableSorting,
  convertApiFiltersToTableFilters,
  convertTableSortingToApiSorting,
  convertTableFiltersToApiFilters,
} from './types'
import { BoxFilters, BoxSorting } from '@/hooks/useBoxes'
import { LocalStorageKey } from '@/enums/LocalStorageKey'
import { getLocalStorageItem, setLocalStorageItem } from '@/lib/local-storage'

interface UseBoxTableProps {
  data: Box[]
  boxIsLoading: Record<string, boolean>
  writePermitted: boolean
  deletePermitted: boolean
  handleStart: (id: string) => void
  handleStop: (id: string) => void
  handleDelete: (id: string) => void
  pagination: {
    pageIndex: number
    pageSize: number
  }
  pageCount: number
  onPaginationChange: (pagination: { pageIndex: number; pageSize: number }) => void
  sorting: BoxSorting
  onSortingChange: (sorting: BoxSorting) => void
  filters: BoxFilters
  onFiltersChange: (filters: BoxFilters) => void
  handleRecover: (id: string) => void
}

export function useBoxTable({
  data,
  boxIsLoading,
  writePermitted,
  deletePermitted,
  handleStart,
  handleStop,
  handleDelete,
  pagination,
  pageCount,
  onPaginationChange,
  sorting,
  onSortingChange,
  filters,
  onFiltersChange,
  handleRecover,
}: UseBoxTableProps) {
  // Column visibility state management with persistence.
  // Minimal default (exe.dev-style): only name + last event + actions show; the rest
  // (id / state / resources / created at) are hidden but toggleable via the View menu.
  // State still leads the name cell as a status dot regardless of the column's visibility.
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(() => {
    const defaults: VisibilityState = { id: false, state: false, resources: false, createdAt: false, labels: false }
    const saved = getLocalStorageItem(LocalStorageKey.BoxTableColumnVisibility)
    if (saved) {
      try {
        return { ...defaults, ...JSON.parse(saved) }
      } catch {
        return defaults
      }
    }
    return defaults
  })

  useEffect(() => {
    setLocalStorageItem(LocalStorageKey.BoxTableColumnVisibility, JSON.stringify(columnVisibility))
  }, [columnVisibility])

  // Convert API sorting and filters to table format for internal use
  const tableSorting = useMemo(() => convertApiSortingToTableSorting(sorting), [sorting])
  const tableFilters = useMemo(() => convertApiFiltersToTableFilters(filters), [filters])

  const columns = useMemo(
    () =>
      getColumns({
        handleStart,
        handleStop,
        handleDelete,
        boxIsLoading,
        writePermitted,
        deletePermitted,
        handleRecover,
      }),
    [handleStart, handleStop, handleDelete, boxIsLoading, writePermitted, deletePermitted, handleRecover],
  )

  const table = useReactTable({
    data,
    columns,
    manualFiltering: true,
    onColumnFiltersChange: (updater) => {
      const newTableFilters = typeof updater === 'function' ? updater(table.getState().columnFilters) : updater
      const newApiFilters = convertTableFiltersToApiFilters(newTableFilters)
      onFiltersChange(newApiFilters)
    },
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    onSortingChange: (updater) => {
      const newTableSorting = typeof updater === 'function' ? updater(table.getState().sorting) : updater
      const newApiSorting = convertTableSortingToApiSorting(newTableSorting)
      onSortingChange(newApiSorting)
    },
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    manualPagination: true,
    pageCount: pageCount,
    onPaginationChange: (updater) => {
      const newPagination = typeof updater === 'function' ? updater(table.getState().pagination) : updater
      onPaginationChange(newPagination)
    },
    getPaginationRowModel: getPaginationRowModel(),
    state: {
      sorting: tableSorting,
      columnFilters: tableFilters,
      columnVisibility,
      pagination: {
        pageIndex: pagination.pageIndex,
        pageSize: pagination.pageSize,
      },
    },
    onColumnVisibilityChange: setColumnVisibility,
    defaultColumn: {
      size: 100,
    },
    enableRowSelection: deletePermitted,
    getRowId: (row) => row.id,
  })

  return {
    table,
  }
}
