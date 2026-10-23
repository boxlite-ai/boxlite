/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ArrowUpRight } from '@/components/ui/icon'
import { downloadUrl } from '@/lib/apps/client'
import { actorName, relTime, STATUS } from '@/lib/apps/format'
import { openApp } from '@/lib/apps/open'
import type { AppDetail, AppRelease, AppTab } from '@/lib/apps/types'
import { cn } from '@/lib/utils'
import { DeployProgress } from './DeployProgress'
import { CopyIconButton } from './spec'

// The top of the Overview: what is live, the app as visitors see it in a browser frame with its
// address, next to the deployment that put it there. Every fact appears once; the header already
// says the app's state.

const host = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/$/, '')

/** The isometric cube of boxlite.ai, as an outline (the site's blEdge cube). */
function IsoCube({ size = 22, tone = 'brand' }: { size?: number; tone?: 'brand' | 'muted' }) {
  const stroke = tone === 'brand' ? 'hsl(var(--brand))' : 'hsl(var(--muted-foreground))'
  const fill = tone === 'brand' ? '0,176,240' : '150,158,170'
  return (
    <svg width={size} height={size * 1.1} viewBox="-11 -7 22 24" aria-hidden="true" className="shrink-0">
      <path d="M0,-6 L10,0 L0,6 L-10,0 Z" fill={`rgba(${fill},.25)`} stroke={stroke} strokeWidth="1.1" />
      <path d="M10,0 L10,10 L0,16 L0,6 Z" fill={`rgba(${fill},.12)`} stroke={stroke} strokeWidth="1.1" />
      <path d="M-10,0 L-10,10 L0,16 L0,6 Z" fill={`rgba(${fill},.05)`} stroke={stroke} strokeWidth="1.1" />
    </svg>
  )
}

/** The app as visitors see it: its last screenshot in a browser frame whose address bar is the URL. */
export function LiveCard({
  app,
  active,
  failing,
  onGoTo,
}: {
  app: AppDetail
  active: AppRelease | null
  failing: boolean
  onGoTo: (tab: AppTab, section?: string, extra?: Record<string, string>) => void
}) {
  const open = () => void openApp(app.id, app.environment)
  // A failing app gets no screenshot: the last good picture would say all is well.
  const preview = app.preview && !failing ? { ...app.preview, src: downloadUrl(app.preview.src) } : null
  const asleep = app.status === 'sleeping'
  return (
    <section className="grid gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,520px)_minmax(0,1fr)]">
      <figure className="min-w-0 border border-border bg-card">
        {/* The browser frame: the address once, here, with copy and open. */}
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span className="flex gap-[5px]" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <span key={i} className="size-[7px] rounded-full bg-border" />
            ))}
          </span>
          <span className="ml-2 flex min-w-0 flex-1 items-center gap-2 bg-background/60 px-2 py-[3px] font-mono text-[12px]">
            <span className="size-[6px] shrink-0" style={{ background: asleep ? STATUS.stopped : STATUS.running }} />
            <span className="min-w-0 truncate text-muted-foreground" title={app.url}>
              {host(app.url)}
            </span>
          </span>
          <CopyIconButton text={app.url} title="Copy URL" />
          {app.activeRelease && (
            <button
              type="button"
              onClick={open}
              aria-label={`Open ${app.name}`}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowUpRight className="size-3.5" />
            </button>
          )}
        </div>
        {preview ? (
          <button type="button" onClick={open} title={`Open ${app.name}`} className="block w-full">
            <img
              src={preview.src}
              alt={`${app.name} at ${preview.releaseId}`}
              className={cn('aspect-[16/10] w-full object-cover object-top', asleep && 'opacity-60 grayscale-[35%]')}
              loading="lazy"
            />
          </button>
        ) : (
          <div className="flex aspect-[16/10] w-full flex-col items-center justify-center gap-3 bg-[radial-gradient(circle_at_50%_45%,hsl(var(--brand)/0.10),transparent_60%)]">
            <IsoCube size={44} tone={failing ? 'muted' : 'brand'} />
            <span className="font-mono text-[12px] text-muted-foreground">
              {failing ? 'Not serving right now' : 'A picture appears after the next deployment'}
            </span>
          </div>
        )}
      </figure>

      <div className="flex min-w-0 flex-col justify-center gap-4">
        <span className="font-mono text-[10px] uppercase tracking-[2px] text-muted-foreground">
          <span className={failing ? 'text-destructive' : 'text-brand'}>▸</span>{' '}
          {failing ? 'Live · not healthy' : asleep ? 'Live · asleep until the next visit' : 'Live now'}
        </span>
        {active ? (
          <>
            <button
              type="button"
              onClick={() => onGoTo('deployments', undefined, { deployment: String(active.number) })}
              className="text-left font-display text-[24px] font-semibold leading-tight tracking-[-0.5px] text-foreground hover:underline"
            >
              {active.summary}
            </button>
            <span className="font-mono text-[13px] text-muted-foreground">
              {active.id} · deployed{' '}
              <span title={new Date(active.createdAt).toLocaleString()}>{relTime(active.createdAt)}</span> by{' '}
              {actorName(active.by)}
            </span>
          </>
        ) : (
          <span className="font-display text-[24px] font-semibold text-foreground">Nothing live yet</span>
        )}
        {app.deploying && !app.activeRelease && (
          <button type="button" className="text-left" onClick={() => onGoTo('deployments')}>
            <DeployProgress deploying={app.deploying} />
          </button>
        )}
        {preview && preview.releaseId !== app.activeRelease && (
          <span className="font-mono text-[12px] text-warning">
            Picture from {preview.releaseId}, captured {relTime(preview.capturedAt)}
          </span>
        )}
      </div>
    </section>
  )
}
