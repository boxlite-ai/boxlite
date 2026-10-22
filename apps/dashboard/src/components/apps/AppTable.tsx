/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxCube } from '@/components/BoxCube'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ArrowUpRight, Trash2 } from '@/components/ui/icon'
import { actorName, appStatusOf, capitalize, relTime, VISIBILITY_LABEL } from '@/lib/apps/format'
import { openApp } from '@/lib/apps/open'
import type { AppSummary } from '@/lib/apps/types'
import { GridHeader, HoverActions, MoreButton, StatusBadge } from './spec'

const GRID = 'grid-cols-[1.5fr_1.8fr_1.4fr_1.4fr_96px] gap-3'

/**
 * The host, readable in a column: tunnel hosts are long and alike at the start and the end, so a
 * long one keeps both ends around a middle ellipsis (10024-d-7641…dev.boxlite.ai). The full URL
 * is on hover and in the copy and open actions.
 */
function shortHost(url: string): string {
  const host = url.replace(/^https?:\/\//, '').replace(/\/$/, '')
  return host.length <= 34 ? host : `${host.slice(0, 12)}…${host.slice(-18)}`
}

export function AppTable({
  apps,
  loading,
  error,
  onRetry,
  onRowClick,
  onDelete,
  onCreate,
}: {
  apps: AppSummary[]
  loading: boolean
  /** The control plane's message when the list could not be read. */
  error: string | null
  onRetry: () => void
  onRowClick: (app: AppSummary) => void
  onDelete: (app: AppSummary) => void
  onCreate?: () => void
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
      ) : error && apps.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 px-6 py-20 text-center font-mono">
          <div className="text-body font-semibold text-foreground">The apps could not be loaded</div>
          <div className="max-w-md text-meta text-muted-foreground">{error}</div>
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 border border-border px-[13px] py-[6px] text-[11px] transition-colors hover:border-brand"
          >
            Retry
          </button>
        </div>
      ) : apps.length === 0 ? (
        <div className="flex flex-col items-center justify-center px-6 py-20 text-center">
          <BoxCube state="empty" size={56} className="mb-4 text-muted-foreground" />
          <div className="font-mono text-body font-semibold text-foreground">No apps yet</div>
          <div className="mt-2 max-w-sm font-mono text-meta text-muted-foreground">
            Create one with a name, then paste its prompt into your coding agent. The agent builds and deploys it.
          </div>
          {onCreate && (
            <button
              type="button"
              onClick={onCreate}
              className="mt-4 border border-border px-[13px] py-[6px] font-mono text-[11px] transition-colors hover:border-brand"
            >
              New App →
            </button>
          )}
        </div>
      ) : (
        apps.map((app) => {
          const status = appStatusOf(app.status)
          return (
            <div
              key={app.id}
              role="link"
              tabIndex={0}
              aria-label={`Open ${app.name}`}
              onClick={() => onRowClick(app)}
              onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && onRowClick(app)}
              className={`group grid ${GRID} cursor-pointer items-center border-b border-border/60 px-2 py-[13px] text-body outline-none transition-colors hover:bg-card/50 focus-visible:bg-card/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/35`}
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
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground" title="The row shows main">
                    {app.environments} environments
                  </span>
                )}
              </span>
              <span className="flex min-w-0 flex-col font-mono text-[12px]">
                {app.status === 'draft' ? (
                  <span className="text-muted-foreground">Not published</span>
                ) : (
                  <>
                    <span className="truncate text-foreground" title={app.url}>
                      {shortHost(app.url)}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {capitalize(VISIBILITY_LABEL[app.visibility])}
                    </span>
                  </>
                )}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <StatusBadge label={status.label} color={status.color} caps />
                {app.progress && (
                  <span className="truncate pl-[15px] font-mono text-[11px] text-warning">{app.progress}</span>
                )}
                {app.attention && !app.progress && (
                  <span className="truncate pl-[15px] font-mono text-[11px] text-destructive" title={app.attention}>
                    {app.attention}
                  </span>
                )}
              </span>
              <span className="truncate font-mono text-[12px] text-muted-foreground">
                {app.lastDeploy ? (
                  <>
                    <span className="text-foreground">{app.lastDeploy.releaseId}</span> · {relTime(app.lastDeploy.at)} ·{' '}
                    {actorName(app.lastDeploy.by, { short: true })}
                  </>
                ) : (
                  '—'
                )}
              </span>
              <span onClick={(e) => e.stopPropagation()}>
                <HoverActions>
                  {app.status !== 'draft' && app.lastDeploy && (
                    <button
                      type="button"
                      onClick={() => void openApp(app.id, 'main')}
                      title="Open app"
                      aria-label={`Open ${app.name} in a new tab`}
                      className="inline-flex size-[28px] items-center justify-center border border-border text-muted-foreground outline-none transition-colors hover:border-brand hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand/35"
                    >
                      <ArrowUpRight className="size-[13px]" />
                    </button>
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
