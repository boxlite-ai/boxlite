/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxCube } from '@/components/BoxCube'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ArrowUpRight, Trash2 } from '@/components/ui/icon'
import { appStatusOf, capitalize, relTime, VISIBILITY_LABEL } from '@/lib/apps/format'
import type { AppSummary } from '@/lib/apps/types'
import { GridHeader, HoverActions, MoreButton, StatusBadge } from './spec'

const GRID = 'grid-cols-[1.5fr_1.8fr_1.4fr_1.4fr_96px] gap-3'

export function AppTable({
  apps,
  loading,
  onRowClick,
  onDelete,
  onOpenQuickstart,
}: {
  apps: AppSummary[]
  loading: boolean
  onRowClick: (app: AppSummary) => void
  onDelete: (app: AppSummary) => void
  onOpenQuickstart?: () => void
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <GridHeader grid={GRID} columns={['Name', 'URL', 'Status', 'Last deployment', 'Actions']} />
      {loading ? (
        Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className={`grid ${GRID} items-center border-b border-border/60 px-2 py-[13px]`}>
            <div className="h-4 w-32 animate-pulse bg-card" />
          </div>
        ))
      ) : apps.length === 0 ? (
        <div className="flex flex-col items-center justify-center px-6 py-20 text-center">
          <BoxCube state="empty" size={56} className="mb-4 text-muted-foreground" />
          <div className="font-mono text-body font-semibold text-foreground">No apps yet</div>
          <div className="mt-2 max-w-sm font-mono text-meta text-muted-foreground">
            Your agent creates one with <span className="font-mono">boxlite app create</span>, or hand it the prompt in
            Quickstart.
          </div>
          {onOpenQuickstart && (
            <button
              type="button"
              onClick={onOpenQuickstart}
              className="mt-4 border border-border px-[13px] py-[6px] font-mono text-[11px] transition-colors hover:border-brand"
            >
              Open Quickstart →
            </button>
          )}
        </div>
      ) : (
        apps.map((app) => {
          const status = appStatusOf(app.status)
          return (
            <div
              key={app.id}
              onClick={() => onRowClick(app)}
              className={`group grid ${GRID} cursor-pointer items-center border-b border-border/60 px-2 py-[13px] text-body transition-colors hover:bg-card/50`}
            >
              <span className="inline-flex min-w-0 items-center gap-3">
                <BoxCube
                  state={
                    app.status === 'failed'
                      ? 'error'
                      : app.status === 'draft'
                        ? 'empty'
                        : app.status === 'sleeping'
                          ? 'stopped'
                          : app.visibility === 'public'
                            ? 'public'
                            : 'persistent'
                  }
                  size={28}
                  className="shrink-0 text-muted-foreground"
                />
                <span className="truncate font-mono font-medium text-foreground">{app.name}</span>
                {app.environments > 1 && (
                  <span
                    className="shrink-0 font-mono text-[11px] text-muted-foreground"
                    title="The row shows production"
                  >
                    {app.environments} environments
                  </span>
                )}
              </span>
              <span className="flex min-w-0 flex-col font-mono text-[12px]">
                {app.url ? (
                  <>
                    <span className="truncate text-foreground">{app.url.replace(/^https:\/\//, '')}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {capitalize(VISIBILITY_LABEL[app.visibility])}
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground">Not published</span>
                )}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <StatusBadge label={status.label} color={status.color} caps />
                {app.attention && (
                  <span className="truncate pl-[15px] font-mono text-[11px] text-destructive" title={app.attention}>
                    {app.attention}
                  </span>
                )}
              </span>
              <span className="truncate font-mono text-[12px] text-muted-foreground">
                {app.lastDeploy ? (
                  <>
                    <span className="text-foreground">{app.lastDeploy.releaseId}</span> · {relTime(app.lastDeploy.at)} ·{' '}
                    {app.lastDeploy.by}
                  </>
                ) : (
                  '—'
                )}
              </span>
              <span onClick={(e) => e.stopPropagation()}>
                <HoverActions>
                  {app.url && (
                    <a
                      href={app.url}
                      target="_blank"
                      rel="noreferrer"
                      title="Open app"
                      aria-label="Open app"
                      className="inline-flex size-[28px] items-center justify-center border border-border text-muted-foreground transition-colors hover:border-brand hover:text-foreground"
                    >
                      <ArrowUpRight className="size-[13px]" />
                    </a>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <MoreButton />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-[12rem] font-mono">
                      <DropdownMenuItem className="cursor-pointer" onClick={() => onRowClick(app)}>
                        Open app page
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="cursor-pointer text-destructive focus:text-destructive"
                        onClick={() => onDelete(app)}
                      >
                        <Trash2 className="size-4" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </HoverActions>
              </span>
            </div>
          )
        })
      )}
      {!loading && apps.length > 0 && (
        <div className="mt-auto pt-4 font-mono text-[10px] uppercase tracking-[1px] text-muted-foreground">
          Showing {apps.length} {apps.length === 1 ? 'app' : 'apps'}
        </div>
      )}
    </div>
  )
}
