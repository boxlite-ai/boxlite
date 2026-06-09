/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { TimestampTooltip } from '@/components/TimestampTooltip'
import { getRelativeTimeString } from '@/lib/utils'
import { BoxTemplateDto, BoxTemplateState } from '@boxlite-ai/api-client'
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

type TemplateTableMeta = {
  writePermitted: boolean
  deletePermitted: boolean
  loadingTemplates: Record<string, boolean>
  getRegionName: (regionId: string) => string | undefined
  onActivate?: (template: BoxTemplateDto) => void
  onDeactivate?: (template: BoxTemplateDto) => void
  onDelete: (template: BoxTemplateDto) => void
  loading: boolean
  selectableCount: number
}

declare module '@tanstack/react-table' {
  interface TableMeta<TData extends RowData> {
    template?: TData extends BoxTemplateDto ? TemplateTableMeta : never
  }
}

interface SortableHeaderProps {
  column: any
  label: string
}

const getMeta = (table: Table<BoxTemplateDto>) => {
  return table.options.meta?.template as TemplateTableMeta
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

const columns: ColumnDef<BoxTemplateDto>[] = [
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
      const { deletePermitted, loadingTemplates, loading } = getMeta(table)

      if (!deletePermitted || row.original.general) {
        return null
      }

      if (loadingTemplates[row.original.id]) {
        return <Loader2 className="w-4 h-4 animate-spin" />
      }

      return (
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={(value) => row.toggleSelected(!!value)}
          aria-label="Select row"
          disabled={!deletePermitted || loadingTemplates[row.original.id] || loading}
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
      const template = row.original
      return (
        <div className="flex items-center gap-2">
          {template.name}
          {template.general && <Badge variant="secondary">System</Badge>}
        </div>
      )
    },
  },
  {
    accessorKey: 'artifactRef',
    enableSorting: false,
    header: 'Artifact',
    cell: ({ row }) => {
      const template = row.original
      if (!template.artifactRef) {
        return <span className="text-muted-foreground">-</span>
      }

      return <span className="block max-w-[220px] truncate font-mono text-xs">{template.artifactRef}</span>
    },
  },
  {
    accessorKey: 'regionIds',
    enableSorting: false,
    header: 'Region',
    cell: ({ row, table }) => {
      const { getRegionName } = getMeta(table)
      const template = row.original
      if (!template.regionIds?.length) {
        return '-'
      }

      const regionNames = template.regionIds.map((id) => getRegionName(id) ?? id)
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
      const template = row.original

      return (
        <div className="flex items-center gap-2 w-full truncate">
          <div className="whitespace-nowrap">
            {template.defaultResources.cpu} <span className="text-muted-foreground">vCPU</span>
          </div>
          <div className="w-[1px] h-6 bg-muted-foreground/20 rounded-full inline-block"></div>
          <div className="whitespace-nowrap">
            {template.defaultResources.memory} <span className="text-muted-foreground">GiB</span>
          </div>
          <div className="w-[1px] h-6 bg-muted-foreground/20 rounded-full inline-block"></div>
          <div className="whitespace-nowrap">
            {template.defaultResources.disk} <span className="text-muted-foreground">GiB</span>
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
      const template = row.original
      const variant = getStateBadgeVariant(template.state)

      if (
        (template.state === BoxTemplateState.ERROR || template.state === BoxTemplateState.BUILD_FAILED) &&
        !!template.errorReason
      ) {
        return (
          <Tooltip>
            <TooltipTrigger>
              <Badge variant={variant}>{getStateLabel(template.state)}</Badge>
            </TooltipTrigger>
            <TooltipContent>
              <p className="max-w-[300px]">{template.errorReason}</p>
            </TooltipContent>
          </Tooltip>
        )
      }

      return <Badge variant={variant}>{getStateLabel(template.state)}</Badge>
    },
  },
  {
    accessorKey: 'createdAt',
    enableSorting: true,
    header: ({ column }) => <SortableHeader column={column} label="Created" />,
    cell: ({ row }) => {
      const template = row.original
      if (template.general) {
        return <span className="text-muted-foreground">-</span>
      }

      const timestamp = getRelativeTimeString(template.createdAt)

      return (
        <TimestampTooltip timestamp={template.createdAt.toString()}>{timestamp.relativeTimeString}</TimestampTooltip>
      )
    },
  },
  {
    accessorKey: 'lastUsedAt',
    enableSorting: true,
    header: ({ column }) => <SortableHeader column={column} label="Last Used" />,
    cell: ({ row }) => {
      const template = row.original
      if (template.general || !template.lastUsedAt) {
        return <span className="text-muted-foreground">-</span>
      }

      const timestamp = getRelativeTimeString(template.lastUsedAt)

      return (
        <TimestampTooltip timestamp={template.lastUsedAt.toString()}>{timestamp.relativeTimeString}</TimestampTooltip>
      )
    },
  },
  {
    id: 'actions',
    cell: ({ row, table }) => {
      const { writePermitted, deletePermitted, loadingTemplates, onActivate, onDeactivate, onDelete } = getMeta(table)

      if ((!writePermitted && !deletePermitted) || row.original.general) {
        return null
      }

      const showActivate = writePermitted && onActivate && row.original.state === BoxTemplateState.INACTIVE
      const showDeactivate = writePermitted && onDeactivate && row.original.state === BoxTemplateState.ACTIVE
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
              <DropdownMenuItem onClick={() => onActivate(row.original)} disabled={loadingTemplates[row.original.id]}>
                Activate
              </DropdownMenuItem>
            )}
            {showDeactivate && (
              <DropdownMenuItem onClick={() => onDeactivate(row.original)} disabled={loadingTemplates[row.original.id]}>
                Deactivate
              </DropdownMenuItem>
            )}
            {showSeparator && <DropdownMenuSeparator />}
            {showDelete && (
              <DropdownMenuItem
                onClick={() => onDelete(row.original)}
                variant="destructive"
                disabled={loadingTemplates[row.original.id]}
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

const getStateBadgeVariant = (state: BoxTemplateState): BadgeProps['variant'] => {
  switch (state) {
    case BoxTemplateState.ACTIVE:
      return 'success'
    case BoxTemplateState.INACTIVE:
      return 'secondary'
    case BoxTemplateState.ERROR:
    case BoxTemplateState.BUILD_FAILED:
      return 'destructive'
    default:
      return 'secondary'
  }
}

const getStateLabel = (state: BoxTemplateState) => {
  if (state === BoxTemplateState.REMOVING) {
    return 'Deleting'
  }
  return state
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}

export { columns }
export type { TemplateTableMeta }
