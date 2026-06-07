/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { TimestampTooltip } from '@/components/TimestampTooltip'
import { getRelativeTimeString } from '@/lib/utils'
import { SavedImageDto, SavedImageState } from '@boxlite-ai/api-client'
import { ColumnDef, RowData, Table } from '@tanstack/react-table'
import { Loader2, MoreHorizontal } from 'lucide-react'
import React from 'react'
import { SortOrderIcon } from '../../SortIcon'
import { Badge, BadgeProps } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Checkbox } from '../../ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'

type SavedImageTableMeta = {
  writePermitted: boolean
  deletePermitted: boolean
  loadingSavedImages: Record<string, boolean>
  getRegionName: (regionId: string) => string | undefined
  onActivate?: (savedImage: SavedImageDto) => void
  onDeactivate?: (savedImage: SavedImageDto) => void
  onDelete: (savedImage: SavedImageDto) => void
  loading: boolean
  selectableCount: number
}

declare module '@tanstack/react-table' {
  interface TableMeta<TData extends RowData> {
    savedImage?: TData extends SavedImageDto ? SavedImageTableMeta : never
  }
}

interface SortableHeaderProps {
  column: any
  label: string
}

const getMeta = (table: Table<SavedImageDto>) => {
  return table.options.meta?.savedImage as SavedImageTableMeta
}

const SortableHeader: React.FC<SortableHeaderProps> = ({ column, label }) => {
  const sortDirection = column.getIsSorted()

  return (
    <button
      type="button"
      onClick={() => column.toggleSorting(sortDirection === 'asc')}
      className="group/sort-button flex items-center gap-2 w-full h-full"
    >
      {label}
      <SortOrderIcon sort={sortDirection || null} />
    </button>
  )
}

const columns: ColumnDef<SavedImageDto>[] = [
  {
    id: 'select',
    header: ({ table }) => {
      const { deletePermitted, loading, selectableCount } = getMeta(table)

      const selectedCount = table.getSelectedRowModel().rows.length
      const anySelectable = selectableCount > 0
      const allSelected = selectedCount > 0 && selectedCount === selectableCount
      const partiallySelected = selectedCount > 0 && selectedCount < selectableCount

      if (!deletePermitted || !anySelectable) {
        return null
      }

      return (
        <Checkbox
          checked={allSelected || (partiallySelected && 'indeterminate')}
          onCheckedChange={() => {
            if (table)
              table.getRowModel().rows.forEach((row) => {
                if (row.original.general) {
                  return
                }
                if (allSelected) {
                  row.toggleSelected(false)
                } else {
                  row.toggleSelected(true)
                }
              })
          }}
          aria-label="Select all"
          disabled={!deletePermitted || loading}
          className="translate-y-[2px]"
        />
      )
    },
    cell: ({ row, table }) => {
      const { deletePermitted, loadingSavedImages, loading } = getMeta(table)

      if (!deletePermitted || row.original.general) {
        return null
      }

      if (loadingSavedImages[row.original.id]) {
        return <Loader2 className="w-4 h-4 animate-spin" />
      }

      return (
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={(value) => row.toggleSelected(!!value)}
          aria-label="Select row"
          disabled={!deletePermitted || loadingSavedImages[row.original.id] || loading}
          className="translate-y-[2px]"
        />
      )
    },
    enableSorting: false,
    enableHiding: false,
  },
  {
    accessorKey: 'name',
    enableSorting: true,
    header: ({ column }) => <SortableHeader column={column} label="Name" />,
    cell: ({ row }) => {
      const savedImage = row.original
      return (
        <div className="flex items-center gap-2">
          {savedImage.name}
          {savedImage.general && <Badge variant="secondary">System</Badge>}
        </div>
      )
    },
  },
  {
    accessorKey: 'artifactRef',
    enableSorting: false,
    header: 'Artifact',
    cell: ({ row }) => {
      const savedImage = row.original
      if (!savedImage.artifactRef) {
        return <span className="text-muted-foreground">-</span>
      }

      return <span className="block max-w-[220px] truncate font-mono text-xs">{savedImage.artifactRef}</span>
    },
  },
  {
    accessorKey: 'regionIds',
    enableSorting: false,
    header: 'Region',
    cell: ({ row, table }) => {
      const { getRegionName } = getMeta(table)
      const savedImage = row.original
      if (!savedImage.regionIds?.length) {
        return '-'
      }

      const regionNames = savedImage.regionIds.map((id) => getRegionName(id) ?? id)
      const firstRegion = regionNames[0]
      const remainingCount = regionNames.length - 1

      if (remainingCount === 0) {
        return (
          <span className="truncate max-w-[150px] block" title={firstRegion}>
            {firstRegion}
          </span>
        )
      }

      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-1.5">
              <span className="truncate max-w-[150px]">{firstRegion}</span>
              <Badge variant="secondary" className="text-xs px-1.5 py-0 h-5">
                +{remainingCount}
              </Badge>
            </div>
          </TooltipTrigger>
          <TooltipContent>
            <div className="flex flex-col gap-1">
              {regionNames.map((name, idx) => (
                <span key={idx}>{name}</span>
              ))}
            </div>
          </TooltipContent>
        </Tooltip>
      )
    },
  },
  {
    id: 'resources',
    enableSorting: false,
    header: 'Resources',
    cell: ({ row }) => {
      const savedImage = row.original

      return (
        <div className="flex items-center gap-2 w-full truncate">
          <div className="whitespace-nowrap">
            {savedImage.defaultResources.cpu} <span className="text-muted-foreground">vCPU</span>
          </div>
          <div className="w-[1px] h-6 bg-muted-foreground/20 rounded-full inline-block"></div>
          <div className="whitespace-nowrap">
            {savedImage.defaultResources.memory} <span className="text-muted-foreground">GiB</span>
          </div>
          <div className="w-[1px] h-6 bg-muted-foreground/20 rounded-full inline-block"></div>
          <div className="whitespace-nowrap">
            {savedImage.defaultResources.disk} <span className="text-muted-foreground">GiB</span>
          </div>
        </div>
      )
    },
  },
  {
    accessorKey: 'state',
    enableSorting: true,
    header: ({ column }) => <SortableHeader column={column} label="State" />,
    cell: ({ row }) => {
      const savedImage = row.original
      const variant = getStateBadgeVariant(savedImage.state)

      if (
        (savedImage.state === SavedImageState.ERROR || savedImage.state === SavedImageState.BUILD_FAILED) &&
        !!savedImage.errorReason
      ) {
        return (
          <Tooltip>
            <TooltipTrigger>
              <Badge variant={variant}>{getStateLabel(savedImage.state)}</Badge>
            </TooltipTrigger>
            <TooltipContent>
              <p className="max-w-[300px]">{savedImage.errorReason}</p>
            </TooltipContent>
          </Tooltip>
        )
      }

      return <Badge variant={variant}>{getStateLabel(savedImage.state)}</Badge>
    },
  },
  {
    accessorKey: 'createdAt',
    enableSorting: true,
    header: ({ column }) => <SortableHeader column={column} label="Created" />,
    cell: ({ row }) => {
      const savedImage = row.original
      if (savedImage.general) {
        return <span className="text-muted-foreground">-</span>
      }

      const timestamp = getRelativeTimeString(savedImage.createdAt)

      return (
        <TimestampTooltip timestamp={savedImage.createdAt.toString()}>{timestamp.relativeTimeString}</TimestampTooltip>
      )
    },
  },
  {
    accessorKey: 'lastUsedAt',
    enableSorting: true,
    header: ({ column }) => <SortableHeader column={column} label="Last Used" />,
    cell: ({ row }) => {
      const savedImage = row.original
      if (savedImage.general || !savedImage.lastUsedAt) {
        return <span className="text-muted-foreground">-</span>
      }

      const timestamp = getRelativeTimeString(savedImage.lastUsedAt)

      return (
        <TimestampTooltip timestamp={savedImage.lastUsedAt.toString()}>{timestamp.relativeTimeString}</TimestampTooltip>
      )
    },
  },
  {
    id: 'actions',
    cell: ({ row, table }) => {
      const { writePermitted, deletePermitted, loadingSavedImages, onActivate, onDeactivate, onDelete } = getMeta(table)

      if ((!writePermitted && !deletePermitted) || row.original.general) {
        return null
      }

      const showActivate = writePermitted && onActivate && row.original.state === SavedImageState.INACTIVE
      const showDeactivate = writePermitted && onDeactivate && row.original.state === SavedImageState.ACTIVE
      const showDelete = deletePermitted

      const showSeparator = (showActivate || showDeactivate) && showDelete

      return (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-8 w-8 p-0">
              <span className="sr-only">Open menu</span>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {showActivate && (
              <DropdownMenuItem onClick={() => onActivate(row.original)} disabled={loadingSavedImages[row.original.id]}>
                Activate
              </DropdownMenuItem>
            )}
            {showDeactivate && (
              <DropdownMenuItem onClick={() => onDeactivate(row.original)} disabled={loadingSavedImages[row.original.id]}>
                Deactivate
              </DropdownMenuItem>
            )}
            {showSeparator && <DropdownMenuSeparator />}
            {showDelete && (
              <DropdownMenuItem
                onClick={() => onDelete(row.original)}
                variant="destructive"
                disabled={loadingSavedImages[row.original.id]}
              >
                Delete
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )
    },
  },
]

const getStateBadgeVariant = (state: SavedImageState): BadgeProps['variant'] => {
  switch (state) {
    case SavedImageState.ACTIVE:
      return 'success'
    case SavedImageState.INACTIVE:
      return 'secondary'
    case SavedImageState.ERROR:
    case SavedImageState.BUILD_FAILED:
      return 'destructive'
    default:
      return 'secondary'
  }
}

const getStateLabel = (state: SavedImageState) => {
  if (state === SavedImageState.REMOVING) {
    return 'Deleting'
  }
  return state
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}

export { columns }
export type { SavedImageTableMeta }
