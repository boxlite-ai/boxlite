/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ResourceEmptyState, StatusIndicator } from '@/components/ResourceLayout'
import { isCheckpointBoxIdle } from '@/lib/checkpoints'
import { AsciiButton } from '@/components/ascii'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { getBoxDisplayName, getBoxPublicIdLabel, getBoxRouteId } from '@/lib/box-identity'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { cn, getRelativeTimeString } from '@/lib/utils'
import { isRecoverable, isStartable, isStoppable, isTransitioning } from '@/lib/utils/box'
import { OrganizationRolePermissionsEnum, Box, BoxProgressPhase, BoxState } from '@boxlite-ai/api-client'
import {
  Check,
  Container,
  Copy,
  Loader2,
  MoreHorizontal,
  Square,
  Plus,
  Play,
  RotateCcw,
  Trash2,
} from '@/components/ui/icon'
import { useState } from 'react'
import { BoxTableProps } from './types'
import { ResourcePagination } from '@/components/ResourcePagination'

// Business states choose semantic colors; shared presentation owns geometry.
const STATUS = {
  running: 'hsl(var(--success))',
  stopped: 'hsl(var(--muted-foreground))',
  error: 'hsl(var(--destructive))',
  idle: 'hsl(var(--warning))',
  dim: 'hsl(var(--muted-foreground))',
} as const

function statusOf(box: Box): { label: string; color: string } {
  switch (box.state) {
    case BoxState.STARTED:
      return { label: 'RUNNING', color: STATUS.running }
    case BoxState.STOPPED:
      return { label: 'STOPPED', color: STATUS.stopped }
    case BoxState.ERROR:
      return { label: 'ERROR', color: STATUS.error }
    case BoxState.CREATING:
      // A first pull is the one slow step the API reports; name it, so a box
      // that sits in CREATING for a minute is not mistaken for a stuck one.
      if (box.progress?.phase === BoxProgressPhase.PREPARING_IMAGE) {
        return { label: 'PULLING IMAGE', color: STATUS.idle }
      }
      return { label: 'STARTING', color: STATUS.idle }
    case BoxState.STARTING:
    case BoxState.RESTORING:
      return { label: 'STARTING', color: STATUS.idle }
    case BoxState.STOPPING:
      return { label: 'STOPPING', color: STATUS.idle }
    case BoxState.DESTROYING:
      return { label: 'DELETING', color: STATUS.idle }
    case BoxState.RESIZING:
      return { label: 'RESIZING', color: STATUS.idle }
    case BoxState.DESTROYED:
      return { label: 'DELETED', color: STATUS.dim }
    default:
      return { label: (box.state ?? 'UNKNOWN').toUpperCase(), color: STATUS.dim }
  }
}

// Proportional columns so the gaps stay even as the table widens, instead of
// dumping all the slack into the Name column.
const GRID = 'grid-cols-[2fr_1.3fr_1fr_120px] gap-x-4'

// Releasing a drag-selection (e.g. selecting a box name to copy it) fires a
// click on the row; navigating away then would discard the selection mid-copy.
function isSelectingText(): boolean {
  const selection = window.getSelection()
  return selection != null && !selection.isCollapsed
}

// One-click name copy that must not trigger the row's navigation click.
/** Copies a box name without triggering navigation from its parent row. */
function CopyNameButton({ name, className }: { name: string; className?: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <button
      type="button"
      title="Copy name"
      onClick={(e) => {
        e.stopPropagation()
        try {
          navigator.clipboard?.writeText(name)
        } catch {
          /* clipboard may be unavailable */
        }
        setCopied(true)
        setTimeout(() => setCopied(false), 1300)
      }}
      className={`shrink-0 text-muted-foreground transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${className ?? ''}`}
    >
      {copied ? <Check className="size-[13px]" style={{ color: STATUS.running }} /> : <Copy className="size-[13px]" />}
    </button>
  )
}

function Quota({ label, value, unit }: { label: string; value: number; unit: string }) {
  return (
    <span className="inline-flex items-baseline gap-[5px] font-mono text-[11px]">
      <span className="text-[9px] tracking-[0.5px] text-muted-foreground">{label}</span>
      <span>{value}</span>
      <span className="text-[9px] text-muted-foreground">{unit}</span>
    </span>
  )
}

/**
 * Renders desktop rows and mobile cards with the same permission- and state-gated actions.
 * Callers own mutations and pagination; action clicks stay separate from row navigation.
 */
export function BoxTable({
  data,
  boxIsLoading,
  boxStateIsTransitioning,
  loading,
  isPageFetching = false,
  handleStart,
  handleStop,
  handleDelete,
  onCreateCheckpoint,
  onRowClick,
  pagination,
  pageCount,
  totalItems,
  onPaginationChange,
  handleRecover,
  onOpenQuickstart,
  filters,
  onFiltersChange,
}: BoxTableProps) {
  const { authenticatedUserHasPermission } = useSelectedOrganization()
  const writePermitted = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_BOXES)
  const deletePermitted = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.DELETE_BOXES)

  const hasFilter = Boolean(filters.idOrName?.trim())
  const pageIndex = pagination.pageIndex
  const pageSize = pagination.pageSize
  const isPagingLocked = loading || isPageFetching
  const shownFirstItem = totalItems === 0 || data.length === 0 ? 0 : Math.min(pageIndex * pageSize + 1, totalItems)
  const shownLastItem =
    totalItems === 0 || data.length === 0 ? 0 : Math.min(pageIndex * pageSize + data.length, totalItems)
  const itemRangeLabel = isPageFetching
    ? 'Loading boxes...'
    : totalItems === 0
      ? 'Showing 0 boxes'
      : `Showing ${shownFirstItem.toLocaleString('en-US')}-${shownLastItem.toLocaleString('en-US')} of ${totalItems.toLocaleString('en-US')} boxes`

  const renderActions = (box: Box, buttonClassName?: string, iconClassName = 'size-4') => {
    const startable = isStartable(box)
    const stoppable = isStoppable(box)
    const recoverable = isRecoverable(box)
    const transitioning = isTransitioning(box)
    const canCheckpoint =
      writePermitted &&
      onCreateCheckpoint &&
      isCheckpointBoxIdle(box) &&
      !boxIsLoading[box.id] &&
      !boxStateIsTransitioning[box.id]

    return (
      <>
        {writePermitted && recoverable && (
          <AsciiButton
            size="icon"
            title="Recover"
            aria-label="Recover"
            onClick={() => handleRecover(box.id)}
            className={buttonClassName}
          >
            <RotateCcw className={iconClassName} strokeWidth={1.3} />
          </AsciiButton>
        )}
        {writePermitted && startable && (
          <AsciiButton
            size="icon"
            title="Start"
            aria-label="Start"
            onClick={() => handleStart(box.id)}
            className={buttonClassName}
          >
            <Play className={iconClassName} strokeWidth={1.3} fill="currentColor" />
          </AsciiButton>
        )}
        {writePermitted && stoppable && (
          <AsciiButton
            size="icon"
            title="Stop"
            aria-label="Stop"
            onClick={() => handleStop(box.id)}
            className={buttonClassName}
          >
            <Square className={iconClassName} strokeWidth={1.3} fill="currentColor" />
          </AsciiButton>
        )}
        {writePermitted && transitioning && !startable && !stoppable && !recoverable && (
          <AsciiButton
            size="icon"
            title="Working…"
            aria-label="Working…"
            onClick={() => undefined}
            disabled
            className={buttonClassName}
          >
            <Loader2 className={`${iconClassName} animate-spin`} strokeWidth={1.3} />
          </AsciiButton>
        )}
        {(deletePermitted || canCheckpoint) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <AsciiButton size="icon" aria-label="More" className={buttonClassName} type="button" title="More">
                <MoreHorizontal className={iconClassName} strokeWidth={1.3} />
              </AsciiButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[12rem]">
              {canCheckpoint && (
                <DropdownMenuItem onClick={() => onCreateCheckpoint?.(box)}>
                  <Plus className="size-4" /> Checkpoint
                </DropdownMenuItem>
              )}
              {deletePermitted && (
                <DropdownMenuItem
                  className="cursor-pointer text-destructive focus:text-destructive"
                  onClick={() => handleDelete(box.id)}
                >
                  <Trash2 className="size-4" />
                  Delete
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </>
    )
  }

  const emptyState = (
    <ResourceEmptyState
      title={hasFilter ? 'No matching Boxes' : 'No boxes yet.'}
      icon={<Container className="size-6" />}
      description={
        hasFilter
          ? 'Try another name or clear your filter.'
          : 'Your agent creates them through the SDK, or you can make one by hand.'
      }
    >
      {hasFilter && (
        <AsciiButton size="sm" onClick={() => onFiltersChange({ ...filters, idOrName: undefined })}>
          Clear filter
        </AsciiButton>
      )}
      {!hasFilter && onOpenQuickstart && (
        <button type="button" onClick={onOpenQuickstart} className="resource-guide-link">
          Open Quickstart →
        </button>
      )}
    </ResourceEmptyState>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* header */}
      <div
        className={cn(
          `hidden ${GRID} resource-list-head flex-none items-center`,
          (loading || totalItems > 0 || hasFilter) && 'md:grid',
        )}
      >
        <span>Name</span>
        <span>Box ID</span>
        <span>Status</span>
        <span className="text-right">Actions</span>
      </div>

      {/* rows */}
      <div
        className={cn('hidden min-h-0 overflow-y-auto md:block', isPageFetching && 'opacity-60 transition-opacity')}
        aria-busy={loading || isPageFetching}
      >
        {loading
          ? Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className={`grid ${GRID} items-center border-b border-border px-[18px] py-3`}>
                <div className="h-4 w-40 animate-pulse bg-card" />
              </div>
            ))
          : data.length === 0
            ? emptyState
            : data.map((box) => {
                const st = statusOf(box)
                const name = getBoxDisplayName(box)
                const busy = boxIsLoading[box.id]
                const transitioning = boxStateIsTransitioning[box.id]

                return (
                  <div
                    key={box.id}
                    onClick={() => {
                      if (isSelectingText()) return
                      onRowClick?.(box)
                    }}
                    className={`group grid ${GRID} resource-list-row items-center ${
                      onRowClick ? 'cursor-pointer' : ''
                    } ${busy ? 'pointer-events-none opacity-70' : ''} ${transitioning ? 'animate-pulse' : ''}`}
                  >
                    {/* the box: its shape drawn, then its name */}
                    <span className="inline-flex min-w-0 items-center gap-3 font-semibold">
                      <Container className="size-6 shrink-0 text-muted-foreground" />
                      <a
                        className="resource-link"
                        href={`/dashboard/boxes/${encodeURIComponent(getBoxRouteId(box))}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
                          if (onRowClick) {
                            event.preventDefault()
                            if (!isSelectingText()) onRowClick(box)
                          }
                        }}
                      >
                        {name}
                      </a>
                      <CopyNameButton name={name} className="opacity-0 group-hover:opacity-100" />
                    </span>

                    {/* box id */}
                    <span className="truncate font-mono text-[11px] text-muted-foreground">
                      {getBoxPublicIdLabel(box)}
                    </span>

                    {/* status */}
                    <StatusIndicator label={st.label} color={st.color} />

                    {/* actions */}
                    <div className="flex justify-end gap-[6px]" onClick={(e) => e.stopPropagation()}>
                      {renderActions(box)}
                    </div>
                  </div>
                )
              })}
      </div>

      <div
        className={cn('min-h-0 space-y-3 overflow-y-auto md:hidden', isPageFetching && 'opacity-60 transition-opacity')}
        role="region"
        aria-label="Box cards"
        aria-busy={loading || isPageFetching}
      >
        {loading
          ? Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="border border-border bg-card p-4">
                <div className="h-4 w-36 animate-pulse bg-background" />
                <div className="mt-4 h-3 w-52 animate-pulse bg-background" />
              </div>
            ))
          : data.length === 0
            ? emptyState
            : data.map((box) => {
                const st = statusOf(box)
                const name = getBoxDisplayName(box)
                const created = getRelativeTimeString(box.createdAt).relativeTimeString.toUpperCase()
                const busy = boxIsLoading[box.id]
                const transitioning = boxStateIsTransitioning[box.id]

                return (
                  <div
                    key={box.id}
                    role={onRowClick ? 'button' : undefined}
                    tabIndex={onRowClick ? 0 : undefined}
                    onClick={() => {
                      if (isSelectingText()) return
                      onRowClick?.(box)
                    }}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget || !onRowClick || (e.key !== 'Enter' && e.key !== ' ')) return
                      e.preventDefault()
                      onRowClick(box)
                    }}
                    className={`w-full border border-border bg-background p-4 text-left transition-colors hover:bg-card focus-visible:border-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:ring-2 focus-visible:ring-brand/35 ${
                      onRowClick ? 'cursor-pointer' : ''
                    } ${busy ? 'pointer-events-none opacity-70' : ''} ${transitioning ? 'animate-pulse' : ''}`}
                  >
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <span className="min-w-0">
                        <span className="flex min-w-0 items-center gap-2 font-semibold">
                          <span style={{ color: 'hsl(var(--brand))' }} className="text-[10px]">
                            ▸
                          </span>
                          <span className="truncate">{name}</span>
                          <CopyNameButton name={name} />
                        </span>
                        <span className="mt-1 block truncate font-mono text-[11px] text-muted-foreground">
                          {getBoxPublicIdLabel(box)}
                        </span>
                      </span>
                      <StatusIndicator label={st.label} color={st.color} />
                    </div>

                    <div className="mt-4 grid grid-cols-3 gap-2 border-y border-dashed border-border py-3">
                      <Quota label="CPU" value={box.cpu} unit="vCPU" />
                      <Quota label="RAM" value={box.memory} unit="GB" />
                      <Quota label="DISK" value={box.disk} unit="GB" />
                    </div>

                    <div className="mt-3 flex items-center justify-between gap-3">
                      <span className="font-mono text-[10px] uppercase tracking-[1px] text-muted-foreground">
                        Created {created}
                      </span>
                      <span className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                        {renderActions(box, 'size-10', 'size-4')}
                      </span>
                    </div>
                  </div>
                )
              })}
      </div>

      <ResourcePagination
        pageIndex={pageIndex}
        pageSize={pageSize}
        pageCount={pageCount}
        totalItems={totalItems}
        isPagingLocked={isPagingLocked}
        isPageFetching={isPageFetching}
        itemRangeLabel={itemRangeLabel}
        onPaginationChange={onPaginationChange}
      />
    </div>
  )
}
