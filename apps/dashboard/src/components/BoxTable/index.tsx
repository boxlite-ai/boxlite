/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ResourceEmptyState, StatusIndicator } from '@/components/ResourceLayout'
import { AsciiButton } from '@/components/ascii'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { getBoxDisplayName, getBoxPublicIdLabel, getBoxRouteId } from '@/lib/box-identity'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { cn, getRelativeTimeString } from '@/lib/utils'
import { isRecoverable, isStartable, isStoppable, isTransitioning } from '@/lib/utils/box'
import { OrganizationRolePermissionsEnum, Box, BoxProgressPhase, BoxState } from '@boxlite-ai/api-client'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Container,
  Copy,
  Loader2,
  MoreHorizontal,
  Square,
  Play,
  RotateCcw,
  Trash2,
} from '@/components/ui/icon'
import { type ReactNode, useState } from 'react'
import { BoxTableProps } from './types'
import { PAGE_SIZE_OPTIONS } from '@/constants/Pagination'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

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
  onRowClick,
  pagination,
  pageCount,
  totalItems,
  onPaginationChange,
  handleRecover,
  onOpenQuickstart,
}: BoxTableProps) {
  const { authenticatedUserHasPermission } = useSelectedOrganization()
  const writePermitted = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_BOXES)
  const deletePermitted = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.DELETE_BOXES)

  const pageIndex = pagination.pageIndex
  const pageSize = pagination.pageSize
  const isPagingLocked = loading || isPageFetching
  const pageTotal = Math.max(pageCount, 1)
  const shownFirstItem = totalItems === 0 || data.length === 0 ? 0 : Math.min(pageIndex * pageSize + 1, totalItems)
  const shownLastItem =
    totalItems === 0 || data.length === 0 ? 0 : Math.min(pageIndex * pageSize + data.length, totalItems)
  const itemRangeLabel = isPageFetching
    ? 'Loading boxes...'
    : totalItems === 0
      ? 'Showing 0 boxes'
      : `Showing ${shownFirstItem.toLocaleString('en-US')}-${shownLastItem.toLocaleString('en-US')} of ${totalItems.toLocaleString('en-US')} boxes`
  const goTo = (index: number) => {
    if (isPagingLocked || index === pageIndex || index < 0 || index >= pageCount) {
      return
    }

    onPaginationChange({ pageIndex: index, pageSize })
  }
  const handlePageSizeChange = (value: string) => {
    const nextPageSize = Number(value)

    if (!Number.isFinite(nextPageSize) || nextPageSize === pageSize) {
      return
    }

    onPaginationChange({ pageIndex: 0, pageSize: nextPageSize })
  }
  const canPrev = pageIndex > 0
  const canNext = pageCount > 0 && pageIndex < pageCount - 1

  const renderActions = (box: Box, buttonClassName?: string, iconClassName = 'size-4') => {
    const startable = isStartable(box)
    const stoppable = isStoppable(box)
    const recoverable = isRecoverable(box)
    const transitioning = isTransitioning(box)

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
        {deletePermitted && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <AsciiButton size="icon" aria-label="More" className={buttonClassName} type="button" title="More">
                <MoreHorizontal className={iconClassName} strokeWidth={1.3} />
              </AsciiButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[12rem]">
              <DropdownMenuItem
                className="cursor-pointer text-destructive focus:text-destructive"
                onClick={() => handleDelete(box.id)}
              >
                <Trash2 className="size-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* header */}
      <div className={`hidden ${GRID} resource-list-head flex-none items-center md:grid`}>
        <span>Name</span>
        <span>Box ID</span>
        <span>Status</span>
        <span className="text-right">Actions</span>
      </div>

      {/* rows */}
      <div
        className={cn(
          'hidden min-h-0 flex-1 overflow-y-auto md:block',
          isPageFetching && 'opacity-60 transition-opacity',
        )}
        aria-busy={loading || isPageFetching}
      >
        {loading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className={`grid ${GRID} items-center border-b border-border px-[18px] py-3`}>
              <div className="h-4 w-40 animate-pulse bg-card" />
            </div>
          ))
        ) : data.length === 0 ? (
          <ResourceEmptyState
            title="No boxes yet."
            icon={<Container className="size-6" />}
            description="Your agent creates them through the SDK, or you can make one by hand."
          >
            {onOpenQuickstart && (
              <button type="button" onClick={onOpenQuickstart} className="resource-guide-link">
                Open Quickstart →
              </button>
            )}
          </ResourceEmptyState>
        ) : (
          data.map((box) => {
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
                <span className="truncate font-mono text-[11px] text-muted-foreground">{getBoxPublicIdLabel(box)}</span>

                {/* status */}
                <StatusIndicator label={st.label} color={st.color} />

                {/* actions */}
                <div className="flex justify-end gap-[6px]" onClick={(e) => e.stopPropagation()}>
                  {renderActions(box)}
                </div>
              </div>
            )
          })
        )}
      </div>

      <div
        className={cn(
          'min-h-0 flex-1 space-y-3 overflow-y-auto md:hidden',
          isPageFetching && 'opacity-60 transition-opacity',
        )}
        aria-busy={loading || isPageFetching}
      >
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="border border-border bg-card p-4">
              <div className="h-4 w-36 animate-pulse bg-background" />
              <div className="mt-4 h-3 w-52 animate-pulse bg-background" />
            </div>
          ))
        ) : data.length === 0 ? (
          <div className="flex flex-col items-center justify-center border border-dashed border-border px-6 py-16 text-center">
            <Container className="mb-4 size-8 text-muted-foreground" strokeWidth={1.3} />
            <div className="text-sm font-medium">No boxes yet.</div>
            <div className="mt-2 max-w-sm text-[13px] text-muted-foreground">
              Spin up a Box with the BoxLite SDK or CLI, or hit “New Box”.
            </div>
            {onOpenQuickstart && (
              <AsciiButton type="button" onClick={onOpenQuickstart} className="mt-4">
                Open Quickstart →
              </AsciiButton>
            )}
          </div>
        ) : (
          data.map((box) => {
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
          })
        )}
      </div>

      {/* footer */}
      <div className="flex flex-none flex-col gap-3 px-0 py-4 font-mono text-[10px] uppercase tracking-[1px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
          <span>{itemRangeLabel}</span>
          <div className="flex items-center gap-2">
            <span className="normal-case tracking-normal">Show</span>
            <Select value={`${pageSize}`} onValueChange={handlePageSizeChange} disabled={isPagingLocked}>
              <SelectTrigger
                aria-label="Rows per page"
                size="xs"
                className="h-8 w-[76px] border-border bg-background px-2 font-mono text-[10px] uppercase tracking-[1px]"
                loading={isPagingLocked}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent side="top">
                {PAGE_SIZE_OPTIONS.map((option) => (
                  <SelectItem key={option} value={`${option}`}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="normal-case tracking-normal">per page</span>
          </div>
        </div>
        <div className="flex items-center gap-[7px] pr-14">
          <span className="inline-flex min-w-[92px] items-center justify-end gap-1 normal-case tracking-normal">
            {isPageFetching ? (
              <>
                <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />
                Loading page {pageIndex + 1}
              </>
            ) : (
              `Page ${pageIndex + 1} of ${pageTotal}`
            )}
          </span>
          {pageCount > 1 && (
            <>
              <PagerButton disabled={isPagingLocked || !canPrev} title="First" onClick={() => goTo(0)}>
                <ChevronsLeft className="size-3.5" />
              </PagerButton>
              <PagerButton disabled={isPagingLocked || !canPrev} title="Previous" onClick={() => goTo(pageIndex - 1)}>
                <ChevronLeft className="size-3.5" />
              </PagerButton>
              <PagerButton disabled={isPagingLocked || !canNext} title="Next" onClick={() => goTo(pageIndex + 1)}>
                <ChevronRight className="size-3.5" />
              </PagerButton>
              <PagerButton disabled={isPagingLocked || !canNext} title="Last" onClick={() => goTo(pageCount - 1)}>
                <ChevronsRight className="size-3.5" />
              </PagerButton>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function PagerButton({
  disabled,
  title,
  onClick,
  children,
}: {
  disabled: boolean
  title: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <AsciiButton size="icon" className="size-9" title={title} aria-label={title} disabled={disabled} onClick={onClick}>
      {children}
    </AsciiButton>
  )
}
