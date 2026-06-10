/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useIsCompactScreen, useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'
import { Calendar, Columns, ListFilter, RefreshCw, Square } from 'lucide-react'
import { DebouncedInput } from '../DebouncedInput'
import { TableColumnVisibilityToggle } from '../TableColumnVisibilityToggle'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'
import { LastEventFilter, LastEventFilterIndicator } from './filters/LastEventFilter'
import { StateFilter, StateFilterIndicator } from './filters/StateFilter'
import { BoxTableHeaderProps } from './types'

export function BoxTableHeader({ table, onRefresh, isRefreshing = false, headerAction }: BoxTableHeaderProps) {
  const isMobile = useIsMobile()
  const isCompactScreen = useIsCompactScreen()

  const stateFilterValue = (table.getColumn('state')?.getFilterValue() as string[]) || []
  const lastEventFilterValue = (table.getColumn('lastEvent')?.getFilterValue() as Date[]) || []

  const hasActiveFilters = stateFilterValue.length > 0 || lastEventFilterValue.length > 0

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <DebouncedInput
          value={(table.getColumn('name')?.getFilterValue() as string) ?? ''}
          onChange={(value) => table.getColumn('name')?.setFilterValue(value)}
          placeholder="Search by name or Box ID"
          className={cn('min-w-0', {
            'w-full': isMobile,
            'min-w-[16rem] flex-1': !isMobile && isCompactScreen,
            'w-[360px]': !isMobile && !isCompactScreen,
          })}
        />

        <Button
          variant="outline"
          onClick={onRefresh}
          disabled={isRefreshing}
          aria-label="Refresh boxes"
          className={cn('flex items-center gap-2', isCompactScreen && 'px-2')}
        >
          <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          {!isCompactScreen && 'Refresh'}
        </Button>

        {!isCompactScreen && (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">
                <Columns className="w-4 h-4" />
                View
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[200px] p-0">
              <TableColumnVisibilityToggle
                columns={table.getAllColumns().filter((column) => ['id'].includes(column.id))}
                getColumnLabel={(id: string) => {
                  switch (id) {
                    case 'id':
                      return 'Internal UUID'
                    default:
                      return id
                  }
                }}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className={cn(isCompactScreen && 'px-3')}>
              <ListFilter className="w-4 h-4" />
              Filter
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-40" align="start">
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Square className="w-4 h-4" />
                State
              </DropdownMenuSubTrigger>
              <DropdownMenuPortal>
                <DropdownMenuSubContent className="p-0 w-64">
                  <StateFilter
                    value={stateFilterValue}
                    onFilterChange={(value) => table.getColumn('state')?.setFilterValue(value)}
                  />
                </DropdownMenuSubContent>
              </DropdownMenuPortal>
            </DropdownMenuSub>
            {/* TODO(image-rewrite): image/template filter removed with the image/template subsystem. */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Calendar className="w-4 h-4" />
                Last Event
              </DropdownMenuSubTrigger>
              <DropdownMenuPortal>
                <DropdownMenuSubContent className="p-3 w-92">
                  <LastEventFilter
                    onFilterChange={(value) => table.getColumn('lastEvent')?.setFilterValue(value)}
                    value={lastEventFilterValue}
                  />
                </DropdownMenuSubContent>
              </DropdownMenuPortal>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>

        {headerAction && <div className={cn('ml-auto', isMobile && 'w-full')}>{headerAction}</div>}
      </div>

      {hasActiveFilters && (
        <div
          className={cn('flex gap-1', {
            'h-8 items-center overflow-x-auto scrollbar-hide': !isCompactScreen,
            'flex-wrap': isCompactScreen,
          })}
        >
          {stateFilterValue.length > 0 && (
            <StateFilterIndicator
              value={stateFilterValue}
              onFilterChange={(value) => table.getColumn('state')?.setFilterValue(value)}
            />
          )}

          {lastEventFilterValue.length > 0 && (
            <LastEventFilterIndicator
              value={lastEventFilterValue}
              onFilterChange={(value) => table.getColumn('lastEvent')?.setFilterValue(value)}
            />
          )}
        </div>
      )}
    </div>
  )
}
