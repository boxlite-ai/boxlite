/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { DEFAULT_BOX_SORTING, BoxFilters, BoxSorting } from '@/hooks/useBoxes'
import {
  ListBoxesPaginatedOrderEnum,
  ListBoxesPaginatedSortEnum,
  ListBoxesPaginatedStatesEnum,
  Box,
  BoxState,
} from '@boxlite-ai/api-client'
import { ColumnFiltersState, SortingState, Table } from '@tanstack/react-table'
import type { ReactNode } from 'react'

export interface BoxTableProps {
  data: Box[]
  boxIsLoading: Record<string, boolean>
  boxStateIsTransitioning: Record<string, boolean>
  loading: boolean
  getRegionName: (regionId: string) => string | undefined
  handleStart: (id: string) => void
  handleStop: (id: string) => void
  handleDelete: (id: string) => void
  handleBulkDelete: (ids: string[]) => void
  handleBulkStart: (ids: string[]) => void
  handleBulkStop: (ids: string[]) => void
  handleVnc: (id: string) => void
  getWebTerminalUrl: (id: string) => Promise<string | null>
  handleCreateSshAccess: (id: string) => void
  handleRevokeSshAccess: (id: string) => void
  handleRefresh: () => void
  isRefreshing?: boolean
  onRowClick?: (box: Box) => void
  pagination: {
    pageIndex: number
    pageSize: number
  }
  pageCount: number
  totalItems: number
  onPaginationChange: (pagination: { pageIndex: number; pageSize: number }) => void
  sorting: BoxSorting
  onSortingChange: (sorting: BoxSorting) => void
  filters: BoxFilters
  onFiltersChange: (filters: BoxFilters) => void
  handleRecover: (id: string) => void
  handleScreenRecordings: (id: string) => void
  headerAction?: ReactNode
}

export interface BoxTableActionsProps {
  box: Box
  layout?: 'table' | 'mobile'
  writePermitted: boolean
  deletePermitted: boolean
  isLoading: boolean
  onStart: (id: string) => void
  onStop: (id: string) => void
  onDelete: (id: string) => void
  onVnc: (id: string) => void
  onOpenWebTerminal: (id: string) => void
  onCreateSshAccess: (id: string) => void
  onRevokeSshAccess: (id: string) => void
  onRecover: (id: string) => void
  onScreenRecordings: (id: string) => void
}

export interface BoxTableHeaderProps {
  table: Table<Box>
  onRefresh: () => void
  isRefreshing?: boolean
  headerAction?: ReactNode
}

export interface FacetedFilterOption {
  label: string
  value: string | BoxState
  icon?: any
}

export const convertTableSortingToApiSorting = (sorting: SortingState): BoxSorting => {
  if (!sorting.length) {
    return DEFAULT_BOX_SORTING
  }

  const sort = sorting[0]
  let field: ListBoxesPaginatedSortEnum

  switch (sort.id) {
    case 'boxId':
      field = ListBoxesPaginatedSortEnum.BOX_ID
      break
    case 'id':
      field = ListBoxesPaginatedSortEnum.ID
      break
    case 'name':
      field = ListBoxesPaginatedSortEnum.NAME
      break
    case 'state':
      field = ListBoxesPaginatedSortEnum.STATE
      break
    // TODO(image-rewrite): template sort removed with the image/template subsystem.
    case 'region':
    case 'target':
      field = ListBoxesPaginatedSortEnum.REGION
      break
    case 'lastEvent':
    case 'updatedAt':
      field = ListBoxesPaginatedSortEnum.UPDATED_AT
      break
    case 'createdAt':
    default:
      field = ListBoxesPaginatedSortEnum.CREATED_AT
      break
  }

  return {
    field,
    direction: sort.desc ? ListBoxesPaginatedOrderEnum.DESC : ListBoxesPaginatedOrderEnum.ASC,
  }
}

export const convertTableFiltersToApiFilters = (columnFilters: ColumnFiltersState): BoxFilters => {
  const filters: BoxFilters = {}

  columnFilters.forEach((filter) => {
    switch (filter.id) {
      case 'name':
        if (filter.value && typeof filter.value === 'string') {
          filters.idOrName = filter.value
        }
        break
      case 'state':
        if (Array.isArray(filter.value) && filter.value.length > 0) {
          filters.states = filter.value as ListBoxesPaginatedStatesEnum[]
        }
        break
      // TODO(image-rewrite): template filter removed with the image/template subsystem.
      case 'region':
      case 'target':
        if (Array.isArray(filter.value) && filter.value.length > 0) {
          filters.regions = filter.value as string[]
        }
        break
      case 'labels':
        if (Array.isArray(filter.value) && filter.value.length > 0) {
          const labelObj: Record<string, string> = {}
          filter.value.forEach((label: string) => {
            const [key, value] = label.split(': ')
            if (key && value) {
              labelObj[key] = value
            }
          })
          if (Object.keys(labelObj).length > 0) {
            filters.labels = labelObj
          }
        }
        break
      case 'resources':
        if (filter.value && typeof filter.value === 'object') {
          const resourceValue = filter.value as {
            cpu?: { min?: number; max?: number }
            memory?: { min?: number; max?: number }
            disk?: { min?: number; max?: number }
          }

          if (resourceValue.cpu?.min !== undefined) {
            filters.minCpu = resourceValue.cpu.min
          }
          if (resourceValue.cpu?.max !== undefined) {
            filters.maxCpu = resourceValue.cpu.max
          }
          if (resourceValue.memory?.min !== undefined) {
            filters.minMemoryGiB = resourceValue.memory.min
          }
          if (resourceValue.memory?.max !== undefined) {
            filters.maxMemoryGiB = resourceValue.memory.max
          }
          if (resourceValue.disk?.min !== undefined) {
            filters.minDiskGiB = resourceValue.disk.min
          }
          if (resourceValue.disk?.max !== undefined) {
            filters.maxDiskGiB = resourceValue.disk.max
          }
        }
        break
      case 'lastEvent':
        if (Array.isArray(filter.value) && filter.value.length > 0) {
          const dateRange = filter.value as (Date | undefined)[]
          if (dateRange[0]) {
            filters.lastEventAfter = dateRange[0]
          }
          if (dateRange[1]) {
            filters.lastEventBefore = dateRange[1]
          }
        }
        break
    }
  })

  return filters
}

export const convertApiSortingToTableSorting = (sorting: BoxSorting): SortingState => {
  if (!sorting.field || !sorting.direction) {
    return [{ id: 'lastEvent', desc: true }]
  }

  let id: string
  switch (sorting.field) {
    case ListBoxesPaginatedSortEnum.BOX_ID:
      id = 'boxId'
      break
    case ListBoxesPaginatedSortEnum.ID:
      id = 'id'
      break
    case ListBoxesPaginatedSortEnum.NAME:
      id = 'name'
      break
    case ListBoxesPaginatedSortEnum.STATE:
      id = 'state'
      break
    // TODO(image-rewrite): template sort removed with the image/template subsystem.
    case ListBoxesPaginatedSortEnum.REGION:
      id = 'region'
      break
    case ListBoxesPaginatedSortEnum.UPDATED_AT:
      id = 'lastEvent'
      break
    case ListBoxesPaginatedSortEnum.CREATED_AT:
    default:
      id = 'createdAt'
      break
  }

  return [{ id, desc: sorting.direction === ListBoxesPaginatedOrderEnum.DESC }]
}

export const convertApiFiltersToTableFilters = (filters: BoxFilters): ColumnFiltersState => {
  const columnFilters: ColumnFiltersState = []

  if (filters.idOrName) {
    columnFilters.push({ id: 'name', value: filters.idOrName })
  }

  if (filters.states && filters.states.length > 0) {
    columnFilters.push({ id: 'state', value: filters.states })
  }

  // TODO(image-rewrite): template filter removed with the image/template subsystem.

  if (filters.regions && filters.regions.length > 0) {
    columnFilters.push({ id: 'region', value: filters.regions })
  }

  if (filters.labels && Object.keys(filters.labels).length > 0) {
    const labelArray = Object.entries(filters.labels).map(([key, value]) => `${key}: ${value}`)
    columnFilters.push({ id: 'labels', value: labelArray })
  }

  // Convert resource filters back to table format
  const resourceValue: {
    cpu?: { min?: number; max?: number }
    memory?: { min?: number; max?: number }
    disk?: { min?: number; max?: number }
  } = {}

  if (filters.minCpu !== undefined || filters.maxCpu !== undefined) {
    resourceValue.cpu = {}
    if (filters.minCpu !== undefined) resourceValue.cpu.min = filters.minCpu
    if (filters.maxCpu !== undefined) resourceValue.cpu.max = filters.maxCpu
  }

  if (filters.minMemoryGiB !== undefined || filters.maxMemoryGiB !== undefined) {
    resourceValue.memory = {}
    if (filters.minMemoryGiB !== undefined) resourceValue.memory.min = filters.minMemoryGiB
    if (filters.maxMemoryGiB !== undefined) resourceValue.memory.max = filters.maxMemoryGiB
  }

  if (filters.minDiskGiB !== undefined || filters.maxDiskGiB !== undefined) {
    resourceValue.disk = {}
    if (filters.minDiskGiB !== undefined) resourceValue.disk.min = filters.minDiskGiB
    if (filters.maxDiskGiB !== undefined) resourceValue.disk.max = filters.maxDiskGiB
  }

  if (Object.keys(resourceValue).length > 0) {
    columnFilters.push({ id: 'resources', value: resourceValue })
  }

  // Convert date range filters back to table format
  if (filters.lastEventAfter || filters.lastEventBefore) {
    const dateRange: (Date | undefined)[] = [undefined, undefined]
    if (filters.lastEventAfter) dateRange[0] = filters.lastEventAfter
    if (filters.lastEventBefore) dateRange[1] = filters.lastEventBefore
    columnFilters.push({ id: 'lastEvent', value: dateRange })
  }

  return columnFilters
}
