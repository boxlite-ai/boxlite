/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { getTemplateDisplayName } from '@/lib/template-display'
import { getSandboxDisplayName, getSandboxPublicIdLabel } from '@/lib/sandbox-identity'
import { formatTimestamp, getRelativeTimeString } from '@/lib/utils'
import { Sandbox, SandboxState } from '@boxlite-ai/api-client'
import { ColumnDef } from '@tanstack/react-table'
import { ArrowDown, ArrowUp } from 'lucide-react'
import React from 'react'
import { EllipsisWithTooltip } from '../EllipsisWithTooltip'
import { ResourceChip } from '../ResourceChip'
import { Checkbox } from '../ui/checkbox'
import { SandboxState as SandboxStateComponent } from './SandboxState'
import { SandboxTableActions } from './SandboxTableActions'

interface SortableHeaderProps {
  column: any
  label: string
  dataState?: string
}

const SortableHeader: React.FC<SortableHeaderProps> = ({ column, label, dataState }) => {
  return (
    <button
      type="button"
      onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
      className="flex h-11 w-full cursor-pointer items-center justify-start rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      {...(dataState && { 'data-state': dataState })}
    >
      {label}
      {column.getIsSorted() === 'asc' ? (
        <ArrowUp className="ml-2 h-4 w-4" />
      ) : column.getIsSorted() === 'desc' ? (
        <ArrowDown className="ml-2 h-4 w-4" />
      ) : (
        <div className="ml-2 w-4 h-4" />
      )}
    </button>
  )
}

interface GetColumnsProps {
  handleStart: (id: string) => void
  handleStop: (id: string) => void
  handleDelete: (id: string) => void
  handleVnc: (id: string) => void
  getWebTerminalUrl: (id: string) => Promise<string | null>
  sandboxIsLoading: Record<string, boolean>
  writePermitted: boolean
  deletePermitted: boolean
  handleCreateSshAccess: (id: string) => void
  handleRevokeSshAccess: (id: string) => void
  handleRecover: (id: string) => void
  getRegionName: (regionId: string) => string | undefined
  handleScreenRecordings: (id: string) => void
}

export function getColumns({
  handleStart,
  handleStop,
  handleDelete,
  handleVnc,
  getWebTerminalUrl,
  sandboxIsLoading,
  writePermitted,
  deletePermitted,
  handleCreateSshAccess,
  handleRevokeSshAccess,
  handleRecover,
  getRegionName,
  handleScreenRecordings,
}: GetColumnsProps): ColumnDef<Sandbox>[] {
  const handleOpenWebTerminal = async (sandboxId: string) => {
    const url = await getWebTerminalUrl(sandboxId)
    if (url) {
      window.open(url, '_blank')
    }
  }

  const columns: ColumnDef<Sandbox>[] = [
    {
      id: 'select',
      size: 30,
      header: ({ table }) => (
        <Checkbox
          checked={
            table.getIsAllPageRowsSelected() ? true : table.getIsSomePageRowsSelected() ? 'indeterminate' : false
          }
          onCheckedChange={(value) => {
            for (const row of table.getRowModel().rows) {
              if (sandboxIsLoading[row.original.id] || row.original.state === SandboxState.DESTROYED) {
                row.toggleSelected(false)
              } else {
                row.toggleSelected(!!value)
              }
            }
          }}
          aria-label="Select all"
          className="translate-y-[2px]"
        />
      ),
      cell: ({ row }) => {
        return (
          <div>
            <Checkbox
              checked={row.getIsSelected()}
              onCheckedChange={(value) => row.toggleSelected(!!value)}
              aria-label="Select row"
              onClick={(e) => e.stopPropagation()}
              className="translate-y-[1px]"
            />
          </div>
        )
      },

      enableSorting: false,
      enableHiding: false,
    },
    {
      id: 'name',
      size: 220,
      enableSorting: true,
      enableHiding: false,
      header: ({ column }) => {
        return <SortableHeader column={column} label="Name" />
      },
      accessorKey: 'name',
      cell: ({ row }) => {
        const displayName = getSandboxDisplayName(row.original)
        return (
          <div className="w-full truncate">
            <span className="truncate block">{displayName}</span>
          </div>
        )
      },
    },
    {
      id: 'boxId',
      size: 140,
      enableSorting: true,
      enableHiding: false,
      header: ({ column }) => {
        return <SortableHeader column={column} label="Box ID" />
      },
      accessorKey: 'boxId',
      cell: ({ row }) => {
        return (
          <div className="w-full truncate">
            <span className="truncate block font-mono text-xs">{getSandboxPublicIdLabel(row.original)}</span>
          </div>
        )
      },
    },
    {
      id: 'id',
      size: 320,
      enableSorting: true,
      enableHiding: true,
      header: ({ column }) => {
        return <SortableHeader column={column} label="Internal UUID" />
      },
      accessorKey: 'id',
      cell: ({ row }) => {
        return (
          <div className="w-full truncate">
            <span className="truncate block">{row.original.id}</span>
          </div>
        )
      },
    },
    {
      id: 'state',
      size: 120,
      enableSorting: true,
      enableHiding: false,
      header: ({ column }) => {
        return <SortableHeader column={column} label="State" />
      },
      cell: ({ row }) => (
        <div className="w-full truncate">
          <SandboxStateComponent
            state={row.original.state}
            errorReason={row.original.errorReason}
            recoverable={row.original.recoverable}
          />
        </div>
      ),
      accessorKey: 'state',
    },
    {
      id: 'template',
      size: 150,
      enableSorting: true,
      enableHiding: false,
      header: ({ column }) => {
        return <SortableHeader column={column} label="Image" />
      },
      cell: ({ row }) => {
        return (
          <div className="w-full truncate">
            {row.original.template ? (
              <EllipsisWithTooltip>{getTemplateDisplayName(row.original.template)}</EllipsisWithTooltip>
            ) : (
              <div className="truncate text-muted-foreground/50">-</div>
            )}
          </div>
        )
      },
      accessorKey: 'template',
    },
    {
      id: 'region',
      size: 80,
      enableSorting: true,
      enableHiding: false,
      header: ({ column }) => {
        return <SortableHeader column={column} label="Region" dataState="sortable" />
      },
      cell: ({ row }) => {
        return (
          <div className="w-full truncate">
            <span className="truncate block">{getRegionName(row.original.target) ?? row.original.target}</span>
          </div>
        )
      },
      accessorKey: 'target',
    },
    {
      id: 'resources',
      size: 230,
      enableSorting: false,
      enableHiding: false,
      header: () => {
        return <span>Resources</span>
      },
      cell: ({ row }) => {
        return (
          <div className="flex w-full items-center gap-1.5 truncate">
            <ResourceChip resource="cpu" value={row.original.cpu} />
            <ResourceChip resource="memory" value={row.original.memory} />
            <ResourceChip resource="disk" value={row.original.disk} />
          </div>
        )
      },
    },
    {
      id: 'lastEvent',
      size: 105,
      enableSorting: true,
      enableHiding: false,
      header: ({ column }) => {
        return <SortableHeader column={column} label="Last Event" />
      },
      accessorFn: (row) => getSandboxLastEvent(row).date,
      cell: ({ row }) => {
        const lastEvent = getSandboxLastEvent(row.original)
        return (
          <div className="w-full truncate">
            <span className="truncate block">{lastEvent.relativeTimeString}</span>
          </div>
        )
      },
    },
    {
      id: 'createdAt',
      size: 170,
      enableSorting: true,
      enableHiding: false,
      header: ({ column }) => {
        return <SortableHeader column={column} label="Created At" />
      },
      cell: ({ row }) => {
        const timestamp = formatTimestamp(row.original.createdAt)
        return (
          <div className="w-full truncate">
            <span className="truncate block">{timestamp}</span>
          </div>
        )
      },
    },
    {
      id: 'actions',
      size: 100,
      enableHiding: false,
      cell: ({ row }) => (
        <div className="w-full flex justify-end">
          <SandboxTableActions
            sandbox={row.original}
            writePermitted={writePermitted}
            deletePermitted={deletePermitted}
            isLoading={sandboxIsLoading[row.original.id]}
            onStart={handleStart}
            onStop={handleStop}
            onDelete={handleDelete}
            onVnc={handleVnc}
            onOpenWebTerminal={handleOpenWebTerminal}
            onCreateSshAccess={handleCreateSshAccess}
            onRevokeSshAccess={handleRevokeSshAccess}
            onRecover={handleRecover}
            onScreenRecordings={handleScreenRecordings}
          />
        </div>
      ),
    },
  ]

  return columns
}

export { getSandboxDisplayName, getSandboxPublicIdLabel }

export function getSandboxLastEvent(sandbox: Sandbox): { date: Date; relativeTimeString: string } {
  return getRelativeTimeString(sandbox.updatedAt)
}
