/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { getBoxDisplayName, getBoxPublicIdLabel } from '@/lib/box-identity'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { getRelativeTimeString } from '@/lib/utils'
import { isRecoverable, isSshAccessible, isStartable, isStoppable } from '@/lib/utils/box'
import { OrganizationRolePermissionsEnum, Box, BoxState } from '@boxlite-ai/api-client'
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Container,
  KeyRound,
  MoreHorizontal,
  Pause,
  Play,
  RotateCcw,
  SquareTerminal,
  Trash2,
} from '@/components/ui/icon'
import { type ReactNode } from 'react'
import { BoxTableProps } from './types'

// Exact design palette (Boxes page.dc.html statusColors) — used inline so the
// status dots/labels render at the precise hue, not a token approximation.
const STATUS = {
  running: '#5ad67d',
  idle: '#e0b341',
  stopped: '#e0564a',
  dim: '#8C919C',
} as const

function statusOf(box: Box): { label: string; color: string } {
  switch (box.state) {
    case BoxState.STARTED:
      return { label: 'RUNNING', color: STATUS.running }
    case BoxState.STOPPED:
      return { label: 'STOPPED', color: STATUS.stopped }
    case BoxState.ERROR:
      return { label: 'ERROR', color: STATUS.stopped }
    case BoxState.CREATING:
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
const GRID = 'grid-cols-[2fr_1.3fr_1fr_1.7fr_1fr_120px] gap-x-4'

function IconButton({
  title,
  onClick,
  children,
}: {
  title: string
  onClick: (e: React.MouseEvent) => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="inline-flex h-[26px] w-7 items-center justify-center border border-border text-foreground transition-colors hover:border-brand hover:bg-brand hover:text-background"
    >
      {children}
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

export function BoxTable({
  data,
  boxIsLoading,
  boxStateIsTransitioning,
  loading,
  handleStart,
  handleStop,
  handleDelete,
  getWebTerminalUrl,
  handleCreateSshAccess,
  handleRevokeSshAccess,
  onRowClick,
  pagination,
  pageCount,
  totalItems,
  onPaginationChange,
  handleRecover,
}: BoxTableProps) {
  const { authenticatedUserHasPermission } = useSelectedOrganization()
  const writePermitted = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_BOXES)
  const deletePermitted = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.DELETE_BOXES)

  const pageIndex = pagination.pageIndex
  const goTo = (index: number) => onPaginationChange({ pageIndex: index, pageSize: pagination.pageSize })
  const canPrev = pageIndex > 0
  const canNext = pageCount > 0 && pageIndex < pageCount - 1

  const openWebTerminal = async (boxId: string) => {
    const url = await getWebTerminalUrl(boxId)
    if (url) window.open(url, '_blank')
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* header */}
      <div
        className={`grid ${GRID} flex-none items-center border-b border-border px-[18px] pb-[11px] font-mono text-[10px] uppercase tracking-[1.2px] text-muted-foreground`}
      >
        <span>Name</span>
        <span>Box ID</span>
        <span>Status</span>
        <span>Resource Quota</span>
        <span>Created</span>
        <span className="text-right">Actions</span>
      </div>

      {/* rows */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className={`grid ${GRID} items-center border-b border-border px-[18px] py-3`}>
              <div className="h-4 w-40 animate-pulse bg-card" />
            </div>
          ))
        ) : data.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-20 text-center">
            <Container className="mb-4 size-8 text-muted-foreground" strokeWidth={1.3} />
            <div className="text-sm font-medium">No boxes yet.</div>
            <div className="mt-2 max-w-sm text-[13px] text-muted-foreground">
              Spin up a Box with the BoxLite SDK or CLI, or hit “New Box”.
            </div>
          </div>
        ) : (
          data.map((box) => {
            const st = statusOf(box)
            const name = getBoxDisplayName(box)
            const created = getRelativeTimeString(box.createdAt).relativeTimeString.toUpperCase()
            const busy = boxIsLoading[box.id]
            const transitioning = boxStateIsTransitioning[box.id]
            const startable = isStartable(box)
            const stoppable = isStoppable(box)
            const sshable = isSshAccessible(box)
            const recoverable = isRecoverable(box)

            return (
              <div
                key={box.id}
                onClick={() => onRowClick?.(box)}
                className={`grid ${GRID} items-center border-b border-border px-[18px] py-3 text-[13px] transition-colors hover:bg-card ${
                  onRowClick ? 'cursor-pointer' : ''
                } ${busy ? 'pointer-events-none opacity-70' : ''} ${transitioning ? 'animate-pulse' : ''}`}
              >
                {/* name */}
                <span className="inline-flex items-center gap-2 truncate font-semibold">
                  <span style={{ color: 'hsl(var(--brand))' }} className="text-[10px]">
                    ▸
                  </span>
                  <span className="truncate">{name}</span>
                </span>

                {/* box id */}
                <span className="truncate font-mono text-[11px] text-muted-foreground">{getBoxPublicIdLabel(box)}</span>

                {/* status */}
                <span className="flex items-center gap-[7px] font-mono text-[11px] tracking-[0.5px]">
                  <span
                    className="size-[7px]"
                    style={{ background: st.color, boxShadow: `0 0 6px ${st.color}` }}
                  />
                  <span style={{ color: st.color }}>{st.label}</span>
                </span>

                {/* resource quota */}
                <div className="flex items-baseline gap-4 truncate pr-4">
                  <Quota label="CPU" value={box.cpu} unit="vCPU" />
                  <Quota label="RAM" value={box.memory} unit="GB" />
                  <Quota label="DISK" value={box.disk} unit="GB" />
                </div>

                {/* created */}
                <span className="font-mono text-[11px] text-muted-foreground">{created}</span>

                {/* actions */}
                <div className="flex justify-end gap-[6px]" onClick={(e) => e.stopPropagation()}>
                  {writePermitted && recoverable && (
                    <IconButton title="Recover" onClick={() => handleRecover(box.id)}>
                      <RotateCcw className="size-[13px]" strokeWidth={1.3} />
                    </IconButton>
                  )}
                  {writePermitted && startable && (
                    <IconButton title="Start" onClick={() => handleStart(box.id)}>
                      <Play className="size-[13px]" strokeWidth={1.3} fill="currentColor" />
                    </IconButton>
                  )}
                  {writePermitted && stoppable && (
                    <IconButton title="Stop" onClick={() => handleStop(box.id)}>
                      <Pause className="size-[13px]" strokeWidth={1.3} fill="currentColor" />
                    </IconButton>
                  )}
                  <IconButton title="SSH / Terminal" onClick={() => (sshable ? openWebTerminal(box.id) : undefined)}>
                    <SquareTerminal className="size-[13px]" strokeWidth={1.3} />
                  </IconButton>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        title="More"
                        className="inline-flex h-[26px] w-7 items-center justify-center border border-border text-foreground outline-none transition-colors hover:border-brand hover:bg-brand hover:text-background data-[state=open]:border-brand data-[state=open]:bg-brand data-[state=open]:text-background"
                      >
                        <MoreHorizontal className="size-[13px]" strokeWidth={1.3} />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-[12rem]">
                      {sshable && (
                        <DropdownMenuItem className="cursor-pointer" onClick={() => openWebTerminal(box.id)}>
                          <SquareTerminal className="size-4" />
                          Open terminal
                        </DropdownMenuItem>
                      )}
                      {writePermitted && sshable && (
                        <DropdownMenuItem className="cursor-pointer" onClick={() => handleCreateSshAccess(box.id)}>
                          <KeyRound className="size-4" />
                          Create SSH access
                        </DropdownMenuItem>
                      )}
                      {writePermitted && (
                        <DropdownMenuItem className="cursor-pointer" onClick={() => handleRevokeSshAccess(box.id)}>
                          <KeyRound className="size-4" />
                          Revoke SSH access
                        </DropdownMenuItem>
                      )}
                      {deletePermitted && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="cursor-pointer text-destructive focus:text-destructive"
                            onClick={() => handleDelete(box.id)}
                          >
                            <Trash2 className="size-4" />
                            Delete
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* footer */}
      <div className="flex flex-none items-center justify-between px-0 py-4 font-mono text-[10px] uppercase tracking-[1px] text-muted-foreground">
        <span>
          Showing {data.length} of {totalItems.toLocaleString('en-US')} boxes
        </span>
        {pageCount > 1 && (
          <div className="flex items-center gap-[7px]">
            <span className="normal-case tracking-normal">
              Page {pageIndex + 1} of {pageCount}
            </span>
            <PagerButton disabled={!canPrev} title="First" onClick={() => goTo(0)}>
              <ChevronsLeft className="size-3.5" />
            </PagerButton>
            <PagerButton disabled={!canPrev} title="Previous" onClick={() => goTo(pageIndex - 1)}>
              <ChevronLeft className="size-3.5" />
            </PagerButton>
            <PagerButton disabled={!canNext} title="Next" onClick={() => goTo(pageIndex + 1)}>
              <ChevronRight className="size-3.5" />
            </PagerButton>
            <PagerButton disabled={!canNext} title="Last" onClick={() => goTo(pageCount - 1)}>
              <ChevronsRight className="size-3.5" />
            </PagerButton>
          </div>
        )}
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
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex size-9 items-center justify-center border border-border text-muted-foreground transition-colors enabled:hover:border-brand enabled:hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  )
}
