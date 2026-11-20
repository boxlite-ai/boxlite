/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { AgentApp, ArrowUpRight, Trash2 } from '@/components/ui/icon'
import { actorName, appStatusOf, capitalize, relTime, VISIBILITY_LABEL } from '@/lib/apps/format'
import { useOpenApp } from '@/lib/apps/open'
import { AppImage } from '@/lib/apps/download'
import type { AppSummary } from '@/lib/apps/types'
import { cn } from '@/lib/utils'
import { useState } from 'react'
import { MoreButton, StatusBadge } from './spec'
import { Link, generatePath } from 'react-router-dom'
import { AppHostingIllustration } from './AppHostingIllustration'
import { RoutePath } from '@/enums/RoutePath'

const GRID = 'grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3'

export function AppCards({
  apps,
  filter,
  loading,
  error,
  onRetry,
  onRowClick,
  onDelete,
  onCreate,
}: {
  apps: AppSummary[]
  /** Set when the list is filtered: an empty result then means "no match", not "no apps". */
  filter?: string
  loading: boolean
  /** The control plane's message when the list could not be read. */
  error: string | null
  onRetry: () => void
  onRowClick: (app: AppSummary) => void
  onDelete?: (app: AppSummary) => void
  onCreate?: () => void
}) {
  const openApp = useOpenApp()
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {loading ? (
        <div className={GRID} aria-label="Loading apps" aria-busy="true">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="border border-border">
              <div className="aspect-video animate-pulse bg-muted/30" />
              <div className="space-y-3 p-5">
                <div className="h-5 w-32 animate-pulse bg-muted/50" />
                <div className="h-4 w-48 animate-pulse bg-muted/30" />
              </div>
            </div>
          ))}
        </div>
      ) : error && apps.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 px-6 py-20 text-center font-sans">
          <div className="text-body font-semibold text-foreground">The apps could not be loaded</div>
          <div className="max-w-md text-meta text-muted-foreground">{error}</div>
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 border border-border px-[13px] py-[6px] text-meta transition-colors hover:border-brand"
          >
            Retry
          </button>
        </div>
      ) : apps.length === 0 && filter ? (
        <div className="px-6 py-14 text-center font-sans text-meta text-muted-foreground">
          No app matches &ldquo;{filter}&rdquo;.
        </div>
      ) : apps.length === 0 ? (
        <div className="flex flex-col items-center justify-center px-6 py-20 text-center">
          <AgentApp className="mb-4 size-14 text-muted-foreground" />
          <div className="font-sans text-body font-semibold text-foreground">No apps yet</div>
          <div className="mt-2 max-w-sm font-sans text-meta text-muted-foreground">
            Create one with a name, then paste its prompt into your coding agent. The agent builds and deploys it.
          </div>
          {onCreate && (
            <button
              type="button"
              onClick={onCreate}
              className="mt-4 border border-border px-[13px] py-[6px] font-sans text-meta transition-colors hover:border-brand"
            >
              New app
            </button>
          )}
        </div>
      ) : (
        <div className={GRID}>
          {apps.map((app) => {
            const status = appStatusOf(app.status)
            return (
              <article
                key={app.id}
                className="group relative min-w-0 border border-border bg-background transition-colors hover:border-muted-foreground/60"
              >
                <AppPreview key={app.previewSrc || app.id} app={app} />
                <div className="space-y-3 p-5">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <h2 className="min-w-0 truncate font-sans text-body font-semibold" title={app.name}>
                      <Link
                        to={generatePath(RoutePath.APP_DETAILS, { appId: app.id })}
                        aria-label={`Open ${app.name}`}
                        className="outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-brand"
                      >
                        {app.name}
                      </Link>
                    </h2>
                    <StatusBadge label={status.label} color={status.color} />
                  </div>
                  <div className="min-w-0 space-y-1">
                    <div className="truncate font-mono text-meta text-muted-foreground" title={app.url}>
                      {app.status === 'draft' ? (
                        <span className="font-sans">Not published</span>
                      ) : (
                        app.url.replace(/^https?:\/\//, '').replace(/\/$/, '')
                      )}
                    </div>
                    <div className="font-sans text-meta text-muted-foreground">
                      {capitalize(VISIBILITY_LABEL[app.visibility])}
                      {app.environments > 1 && ` · ${app.environments} environments`}
                    </div>
                  </div>
                  {app.progress && <p className="break-words text-meta text-warning">{app.progress}</p>}
                  {app.attention && !app.progress && (
                    <p className="break-words text-meta text-destructive">{app.attention}</p>
                  )}
                  {app.status === 'draft' && !!app.liveIn?.length && (
                    <p className="break-words text-meta text-muted-foreground">Running in {app.liveIn.join(', ')}</p>
                  )}
                </div>
                <div className="flex min-w-0 items-center justify-between gap-3 border-t border-border px-5 py-3">
                  <div
                    className="min-w-0 truncate font-sans text-meta text-muted-foreground"
                    title={
                      app.lastDeploy
                        ? `Last deployment ${app.lastDeploy.releaseId} · ${relTime(app.lastDeploy.at)} · ${actorName(app.lastDeploy.by, { short: true })}`
                        : undefined
                    }
                  >
                    {app.lastDeploy ? (
                      <>
                        {app.lastDeploy.releaseId} · {relTime(app.lastDeploy.at)}
                      </>
                    ) : (
                      'No deployments yet'
                    )}
                  </div>
                  <div className="relative z-10 flex shrink-0 items-center gap-2">
                    {app.status !== 'draft' && app.lastDeploy && (
                      <button
                        type="button"
                        onClick={() => void openApp(app.id, 'main')}
                        aria-label={`Open ${app.name} in a new tab`}
                        className="inline-flex items-center gap-1.5 font-sans text-meta text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand"
                      >
                        Open app <ArrowUpRight className="size-4" />
                      </button>
                    )}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <MoreButton />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-48 font-sans">
                        <DropdownMenuItem className="cursor-pointer" onClick={() => onRowClick(app)}>
                          Open app page
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="cursor-pointer text-destructive focus:text-destructive"
                          disabled={!onDelete}
                          onClick={() => onDelete?.(app)}
                        >
                          <Trash2 className="size-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      )}
      {!loading && apps.length > 0 && (
        <div className="resource-footer mt-auto">
          Showing {apps.length} {apps.length === 1 ? 'app' : 'apps'}
        </div>
      )}
    </div>
  )
}

/** Keep the fallback visible until the authenticated screenshot has actually loaded. */
function AppPreview({ app }: { app: AppSummary }) {
  const [loaded, setLoaded] = useState(false)
  return (
    <div className="relative flex aspect-video items-center justify-center overflow-hidden border-b border-border bg-muted/20">
      <AppHostingIllustration
        compact
        draft={app.status === 'draft'}
        className="absolute inset-[18%] size-[64%] opacity-80"
      />
      {app.previewSrc && (
        <AppImage
          path={app.previewSrc}
          alt=""
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => setLoaded(false)}
          className={cn(
            'absolute inset-0 size-full object-cover object-top',
            !loaded && 'opacity-0',
            app.status === 'sleeping' && 'grayscale',
          )}
        />
      )}
    </div>
  )
}
