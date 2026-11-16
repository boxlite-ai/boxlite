/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Box, BoxState, OrganizationRolePermissionsEnum } from '@boxlite-ai/api-client'
import { Checkpoint, CheckpointStatus } from '@/api/checkpoint-types'
import { Link, generatePath } from 'react-router-dom'
import { RoutePath } from '@/enums/RoutePath'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { formatBytes, timeAgo } from '@/lib/format'
import { CheckpointGlyph, CheckpointStatusIndicator } from './CheckpointGlyph'
import { ResourceFilterEmptyState, ResourceEmptyState, ResourceIdentity, ResourceLoadingState } from './ResourceLayout'
import { Trash } from './ui/icon'
import { AsciiButton as Button } from './ascii'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'

interface CheckpointTableProps {
  data: Checkpoint[]
  boxes?: Box[]
  loading: boolean
  filtered: boolean
  onClearFilter: () => void
  onCreateBox: (checkpoint: Checkpoint) => void
  createBoxEnabled: boolean
  onDelete: (checkpoint: Checkpoint) => void
}

export function CheckpointTable({
  data,
  boxes,
  loading,
  filtered,
  onClearFilter,
  onCreateBox,
  createBoxEnabled,
  onDelete,
}: CheckpointTableProps) {
  const { authenticatedUserHasPermission } = useSelectedOrganization()
  const canWrite = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_BOXES)
  const canDelete = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_BOXES)
  const byId = new Map(boxes?.map((box) => [box.id, box]))
  if (loading) return <ResourceLoadingState title="Loading checkpoints…" />
  if (data.length === 0) {
    return filtered ? (
      <ResourceFilterEmptyState title="No checkpoints match your filter" onClear={onClearFilter} />
    ) : (
      <ResourceEmptyState
        icon={<CheckpointGlyph />}
        title="No checkpoints yet"
        description="Save a Box’s disk and use it to create another Box."
      />
    )
  }

  return (
    <Table className="resource-table min-w-[1040px] table-fixed border-separate border-spacing-0">
      <colgroup>
        <col />
        <col className="w-[14%]" />
        <col className="w-[18%]" />
        <col className="w-[104px]" />
        <col className="w-[108px]" />
        <col className="w-[88px]" />
        <col className="w-[144px]" />
      </colgroup>
      <TableHeader>
        <TableRow className="bg-transparent hover:bg-transparent">
          {['Name', 'ID', 'Source Box', 'Status', 'Archive size', 'Created', 'Actions'].map((label) => (
            <TableHead key={label} className="resource-list-head last:text-right">
              {label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody className="[&_td]:border-b [&_td]:border-border/60">
        {data.map((checkpoint) => {
          const source = byId.get(checkpoint.source_box_id)
          const deleted = boxes !== undefined && (!source || source.state === BoxState.DESTROYED)
          const ready = checkpoint.state === CheckpointStatus.READY
          const failed = checkpoint.state === CheckpointStatus.FAILED
          return (
            <TableRow
              key={checkpoint.id}
              className="border-border/60 bg-transparent hover:bg-accent/40 focus-within:bg-accent/40 [&_td]:whitespace-nowrap"
            >
              <TableCell>
                <ResourceIdentity icon={<CheckpointGlyph state={checkpoint.state} />}>
                  <span className="resource-name" title={checkpoint.name}>
                    {checkpoint.name}
                  </span>
                </ResourceIdentity>
              </TableCell>
              <TableCell className="font-mono text-meta text-muted-foreground">
                <span className="block truncate" title={checkpoint.id}>
                  {checkpoint.id}
                </span>
              </TableCell>
              <TableCell className="font-mono text-meta">
                {deleted ? (
                  <span
                    className="block truncate text-muted-foreground"
                    title={`${checkpoint.source_box_id} (deleted)`}
                  >
                    {checkpoint.source_box_id} (deleted)
                  </span>
                ) : source ? (
                  <Link
                    className="block underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4"
                    to={generatePath(RoutePath.BOX_DETAILS, { boxId: source.id })}
                  >
                    <span className="block truncate" title={source.name || source.id}>
                      {source.name || source.id}
                    </span>
                  </Link>
                ) : (
                  <span className="block truncate text-muted-foreground" title={checkpoint.source_box_id}>
                    {checkpoint.source_box_id}
                  </span>
                )}
              </TableCell>
              <TableCell>
                <CheckpointStatusIndicator checkpoint={checkpoint} />
              </TableCell>
              <TableCell className="font-mono text-meta">{ready ? formatBytes(checkpoint.size_bytes) : '—'}</TableCell>
              <TableCell className="font-mono text-meta text-muted-foreground" title={checkpoint.created_at}>
                {timeAgo(checkpoint.created_at)}
              </TableCell>
              <TableCell>
                <div className="flex items-center justify-end gap-[6px]">
                  <Button
                    size="sm"
                    variant="quiet"
                    aria-label={`Create Box from ${checkpoint.name}`}
                    disabled={!canWrite || !ready || !createBoxEnabled}
                    onClick={() => onCreateBox(checkpoint)}
                  >
                    New Box
                  </Button>
                  <Button
                    size="icon"
                    variant="quiet-danger"
                    aria-label={`Delete ${checkpoint.name}`}
                    title={`Delete ${checkpoint.name}`}
                    disabled={!canDelete || (!ready && !failed && checkpoint.state !== CheckpointStatus.DELETING)}
                    onClick={() => onDelete(checkpoint)}
                  >
                    <Trash className="size-4" strokeWidth={1.3} />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
