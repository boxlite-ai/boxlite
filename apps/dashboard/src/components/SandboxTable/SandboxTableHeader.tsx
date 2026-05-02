/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useIsCompactScreen, useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'
import {
  ArrowUpDown,
  Calendar,
  Camera,
  Check,
  Columns,
  Cpu,
  Globe,
  HardDrive,
  ListFilter,
  MemoryStick,
  RefreshCw,
  Square,
  Tag,
} from 'lucide-react'
import * as React from 'react'
import { DebouncedInput } from '../DebouncedInput'
import { TableColumnVisibilityToggle } from '../TableColumnVisibilityToggle'
import { Button } from '../ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandInputButton,
  CommandItem,
  CommandList,
} from '../ui/command'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { LabelFilter, LabelFilterIndicator } from './filters/LabelFilter'
import { LastEventFilter, LastEventFilterIndicator } from './filters/LastEventFilter'
import { RegionFilter, RegionFilterIndicator } from './filters/RegionFilter'
import { ResourceFilter, ResourceFilterIndicator, ResourceFilterValue } from './filters/ResourceFilter'
import { SnapshotFilter, SnapshotFilterIndicator } from './filters/SnapshotFilter'
import { StateFilter, StateFilterIndicator } from './filters/StateFilter'
import { SandboxTableHeaderProps } from './types'

const RESOURCE_FILTERS = [
  { type: 'cpu' as const, label: 'CPU', icon: Cpu },
  { type: 'memory' as const, label: 'Memory', icon: MemoryStick },
  { type: 'disk' as const, label: 'Disk', icon: HardDrive },
]

export function SandboxTableHeader({
  table,
  regionOptions,
  regionsDataIsLoading,
  snapshots,
  snapshotsDataIsLoading,
  snapshotsDataHasMore,
  onChangeSnapshotSearchValue,
  onRefresh,
  isRefreshing = false,
}: SandboxTableHeaderProps) {
  const isMobile = useIsMobile()
  const isCompactScreen = useIsCompactScreen()
  const [open, setOpen] = React.useState(false)
  const currentSort = table.getState().sorting[0]?.id || ''

  const sortableColumns = [
    { id: 'name', label: 'Name' },
    { id: 'state', label: 'State' },
    { id: 'snapshot', label: 'Snapshot' },
    { id: 'region', label: 'Region' },
    { id: 'lastEvent', label: 'Last Event' },
  ]

  const stateFilterValue = (table.getColumn('state')?.getFilterValue() as string[]) || []
  const snapshotFilterValue = (table.getColumn('snapshot')?.getFilterValue() as string[]) || []
  const regionFilterValue = (table.getColumn('region')?.getFilterValue() as string[]) || []
  const resourceFilterValue = (table.getColumn('resources')?.getFilterValue() as ResourceFilterValue) || {}
  const labelFilterValue = (table.getColumn('labels')?.getFilterValue() as string[]) || []
  const lastEventFilterValue = (table.getColumn('lastEvent')?.getFilterValue() as Date[]) || []

  const hasActiveFilters =
    stateFilterValue.length > 0 ||
    snapshotFilterValue.length > 0 ||
    regionFilterValue.length > 0 ||
    RESOURCE_FILTERS.some((filter) => Boolean(resourceFilterValue[filter.type])) ||
    labelFilterValue.length > 0 ||
    lastEventFilterValue.length > 0

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <DebouncedInput
          value={(table.getColumn('name')?.getFilterValue() as string) ?? ''}
          onChange={(value) => table.getColumn('name')?.setFilterValue(value)}
          placeholder="Search by Name or UUID"
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
          aria-label="Refresh sandboxes"
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
                columns={table.getAllColumns().filter((column) => ['name', 'id', 'labels'].includes(column.id))}
                getColumnLabel={(id: string) => {
                  switch (id) {
                    case 'name':
                      return 'Name'
                    case 'id':
                      return 'UUID'
                    case 'labels':
                      return 'Labels'
                    default:
                      return id
                  }
                }}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={open}
              className={cn('justify-between', {
                'min-w-[180px] flex-1': isMobile,
                'w-[200px]': !isMobile && isCompactScreen,
                'w-[240px]': !isMobile && !isCompactScreen,
              })}
            >
              {currentSort ? (
                <div className="flex items-center gap-2">
                  <div className="text-muted-foreground font-normal">
                    {isCompactScreen ? 'Sort:' : 'Sorted by:'}{' '}
                    <span className="font-medium text-primary">
                      {sortableColumns.find((column) => column.id === currentSort)?.label}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <ArrowUpDown className="w-4 h-4" />
                  <span>Sort</span>
                </div>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[240px] p-0" align="start">
            <Command>
              <CommandInput placeholder="Search...">
                <CommandInputButton
                  aria-expanded={open}
                  className="justify-between"
                  onClick={() => {
                    table.resetSorting()
                    setOpen(false)
                  }}
                >
                  Reset
                </CommandInputButton>
              </CommandInput>
              <CommandList>
                <CommandEmpty>No column found.</CommandEmpty>
                <CommandGroup>
                  {sortableColumns.map((column) => (
                    <CommandItem
                      key={column.id}
                      value={column.id}
                      onSelect={(currentValue) => {
                        const col = table.getColumn(currentValue)
                        if (col) {
                          col.toggleSorting(false)
                        }
                        setOpen(false)
                      }}
                    >
                      <Check className={cn('mr-2 h-4 w-4', currentSort === column.id ? 'opacity-100' : 'opacity-0')} />
                      {column.label}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

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
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Camera className="w-4 h-4" />
                Snapshot
              </DropdownMenuSubTrigger>
              <DropdownMenuPortal>
                <DropdownMenuSubContent className="p-0 w-64">
                  <SnapshotFilter
                    value={snapshotFilterValue}
                    onFilterChange={(value) => table.getColumn('snapshot')?.setFilterValue(value)}
                    snapshots={snapshots}
                    isLoading={snapshotsDataIsLoading}
                    hasMore={snapshotsDataHasMore}
                    onChangeSnapshotSearchValue={onChangeSnapshotSearchValue}
                  />
                </DropdownMenuSubContent>
              </DropdownMenuPortal>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Globe className="w-4 h-4" />
                Region
              </DropdownMenuSubTrigger>
              <DropdownMenuPortal>
                <DropdownMenuSubContent className="p-0 w-64">
                  <RegionFilter
                    value={regionFilterValue}
                    onFilterChange={(value) => table.getColumn('region')?.setFilterValue(value)}
                    options={regionOptions}
                    isLoading={regionsDataIsLoading}
                  />
                </DropdownMenuSubContent>
              </DropdownMenuPortal>
            </DropdownMenuSub>
            {RESOURCE_FILTERS.map(({ type, label, icon: Icon }) => (
              <DropdownMenuSub key={type}>
                <DropdownMenuSubTrigger>
                  <Icon className="w-4 h-4" />
                  {label}
                </DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent className="p-3 w-64">
                    <ResourceFilter
                      value={resourceFilterValue}
                      onFilterChange={(value) => table.getColumn('resources')?.setFilterValue(value)}
                      resourceType={type}
                    />
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
            ))}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Tag className="w-4 h-4" />
                Labels
              </DropdownMenuSubTrigger>
              <DropdownMenuPortal>
                <DropdownMenuSubContent className="p-0 w-64">
                  <LabelFilter
                    value={labelFilterValue}
                    onFilterChange={(value) => table.getColumn('labels')?.setFilterValue(value)}
                  />
                </DropdownMenuSubContent>
              </DropdownMenuPortal>
            </DropdownMenuSub>
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

          {snapshotFilterValue.length > 0 && (
            <SnapshotFilterIndicator
              value={snapshotFilterValue}
              onFilterChange={(value) => table.getColumn('snapshot')?.setFilterValue(value)}
              snapshots={snapshots}
              isLoading={snapshotsDataIsLoading}
              hasMore={snapshotsDataHasMore}
              onChangeSnapshotSearchValue={onChangeSnapshotSearchValue}
            />
          )}

          {regionFilterValue.length > 0 && (
            <RegionFilterIndicator
              value={regionFilterValue}
              onFilterChange={(value) => table.getColumn('region')?.setFilterValue(value)}
              options={regionOptions}
              isLoading={regionsDataIsLoading}
            />
          )}

          {RESOURCE_FILTERS.map(({ type }) => {
            const resourceValue = resourceFilterValue[type]
            return resourceValue ? (
              <ResourceFilterIndicator
                key={type}
                value={resourceFilterValue}
                onFilterChange={(value) => table.getColumn('resources')?.setFilterValue(value)}
                resourceType={type}
              />
            ) : null
          })}

          {labelFilterValue.length > 0 && (
            <LabelFilterIndicator
              value={labelFilterValue}
              onFilterChange={(value) => table.getColumn('labels')?.setFilterValue(value)}
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
