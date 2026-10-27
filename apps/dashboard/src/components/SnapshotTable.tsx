/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Box, BoxState, OrganizationRolePermissionsEnum } from '@boxlite-ai/api-client'
import { Snapshot, SnapshotStatus } from '@/lib/cloudSnapshot'
import { Link, generatePath } from 'react-router-dom'
import { RoutePath } from '@/enums/RoutePath'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { formatBytes, timeAgo } from '@/lib/format'
import { SnapshotGlyph } from './SnapshotGlyph'
import { Database, Plus, Trash } from './ui/icon'
import { Button } from './ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

interface SnapshotTableProps {
  data: Snapshot[]
  boxes?: Box[]
  loading: boolean
  filtered: boolean
  onCreate: () => void
  onCreateBox: (snapshot: Snapshot) => void
  createBoxEnabled: boolean
  onDelete: (snapshot: Snapshot) => void
}

export function SnapshotTable({
  data,
  boxes,
  loading,
  filtered,
  onCreate,
  onCreateBox,
  createBoxEnabled,
  onDelete,
}: SnapshotTableProps) {
  const { authenticatedUserHasPermission } = useSelectedOrganization()
  const canWrite = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_BOXES)
  const canDelete = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.DELETE_BOXES)
  const byId = new Map(boxes?.map((box) => [box.id, box]))
  return (
    <Table className="min-w-[850px]">
      <TableHeader>
        <TableRow className="bg-transparent hover:bg-transparent">
          {['Name', 'Source box', 'Status', 'Size', 'Disk (GiB)', 'Created', 'Actions'].map((label) => (
            <TableHead
              key={label}
              className="h-auto pb-2 font-mono text-[10px] uppercase leading-normal tracking-[1px] last:text-right"
            >
              {label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody className="[&_tr]:h-[55px] [&_tr:last-child]:border-b [&_td]:py-[13px] [&_td]:tracking-normal">
        {loading ? (
          <TableRow className="border-border/60 bg-transparent hover:bg-transparent">
            <TableCell colSpan={7} className="h-40 text-center" role="status">
              Loading snapshots…
            </TableCell>
          </TableRow>
        ) : data.length === 0 ? (
          <TableRow className="border-border/60 bg-transparent hover:bg-transparent">
            <TableCell colSpan={7} className="h-64 text-center">
              <Database className="mx-auto mb-4 size-6 text-muted-foreground" />
              <p className="font-mono font-semibold">
                {filtered ? 'No snapshots match your filter' : 'No snapshots yet'}
              </p>
              {!filtered && (
                <>
                  <p className="my-3 text-sm text-muted-foreground">
                    Save a stopped box’s disk and use it to create another box.
                  </p>
                  <Button disabled={!canWrite} onClick={onCreate}>
                    New Snapshot
                  </Button>
                </>
              )}
            </TableCell>
          </TableRow>
        ) : (
          data.map((snapshot) => {
            const source = byId.get(snapshot.sourceBoxId)
            const deleted = boxes !== undefined && (!source || source.state === BoxState.DESTROYED)
            const ready = snapshot.status === SnapshotStatus.READY
            const failed = snapshot.status === SnapshotStatus.FAILED
            return (
              <TableRow
                key={snapshot.id}
                className="border-border/60 bg-transparent hover:bg-transparent [&_td]:whitespace-nowrap"
              >
                <TableCell className="max-w-[220px] font-mono text-[13px] font-medium" title={snapshot.id}>
                  <span className="flex min-w-0 items-center gap-3">
                    <SnapshotGlyph state={snapshot.status} size={28} className="text-muted-foreground" />
                    <span className="truncate">{snapshot.name}</span>
                  </span>
                </TableCell>
                <TableCell
                  className="max-w-[240px] truncate font-mono text-xs"
                  title={deleted ? `${snapshot.sourceBoxId} (deleted)` : source?.name || snapshot.sourceBoxId}
                >
                  {deleted ? (
                    <span className="text-muted-foreground">{snapshot.sourceBoxId} (deleted)</span>
                  ) : source ? (
                    <Link className="hover:underline" to={generatePath(RoutePath.BOX_DETAILS, { boxId: source.id })}>
                      {source.name || source.id}
                    </Link>
                  ) : (
                    <span>{snapshot.sourceBoxId}</span>
                  )}
                </TableCell>
                <TableCell>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        tabIndex={failed ? 0 : undefined}
                        className={`inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.5px] ${failed ? 'text-destructive' : ready ? 'text-brand' : 'text-muted-foreground'}`}
                      >
                        <span
                          className={`size-1.5 bg-current ${snapshot.status === SnapshotStatus.CREATING ? 'animate-pulse' : ''}`}
                        />
                        {snapshot.status}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>{snapshot.error || snapshot.status}</TooltipContent>
                  </Tooltip>
                </TableCell>
                <TableCell className="font-mono text-xs">{ready ? formatBytes(snapshot.sizeBytes) : '—'}</TableCell>
                <TableCell className="font-mono text-xs">{snapshot.diskGb}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground" title={snapshot.createdAt}>
                  {timeAgo(snapshot.createdAt)}
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-[6px]">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-[6px] border-border bg-transparent px-[9px] py-[5px] font-mono text-[11px] font-normal tracking-normal text-muted-foreground hover:border-brand hover:bg-transparent hover:text-foreground"
                      aria-label={`Create Box from ${snapshot.name}`}
                      disabled={!canWrite || !ready || !createBoxEnabled}
                      onClick={() => onCreateBox(snapshot)}
                    >
                      <Plus className="size-[13px]" /> Box
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-auto border-border bg-transparent p-[6px] text-muted-foreground hover:border-destructive hover:bg-transparent hover:text-destructive"
                      aria-label={`Delete ${snapshot.name}`}
                      disabled={!canDelete || (!ready && !failed)}
                      onClick={() => onDelete(snapshot)}
                    >
                      <Trash className="size-[13px]" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            )
          })
        )}
      </TableBody>
    </Table>
  )
}
